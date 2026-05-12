// biu — CSS/SCSS compilation & processing

import CleanCSS from "clean-css";
import { build } from "bun";
import * as sass from "sass";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { contentHash } from "./utils.ts";

/**
 * CleanCSS 单例，仍然用于 **字符串级别** 的 CSS 压缩场景
 * （HTML 内联 <style>、JS/TS 模板字面量中的 css`...`），
 * 因为 Bun.build 的 CSS minifier 目前只作用于文件级 bundling pipeline，
 * 没有暴露直接压缩字符串的 API。
 */
export const cleanCss = new CleanCSS();

/**
 * Bun 的 CSS bundler 会把小于 128KB 的 url(...) 资源强制 base64 内联，
 * 且目前没有配置项可以关闭（参见 oven-sh/bun#24599）。biu 依赖 url()
 * 原样保留，后续在 updateCssUrls() 中重写为带 hash 的资源路径，所以在
 * 调用 Bun.build 之前我们先把所有非 data: 的 url(...) 用占位符替换，
 * build 完成后再把它们一一还原回去。
 *
 * 占位符使用一个 `https://` 开头的假 URL —— Bun 遇到外部 scheme 的资源
 * 引用会原样保留，不会尝试到文件系统或网络去解析它。
 */
const URL_PLACEHOLDER_PREFIX = "https://biu.invalid/url/";

function maskUrls(css: string): { masked: string; originals: string[] } {
  const originals: string[] = [];
  const masked = css.replace(
    /url\(\s*(?!["']?data\s*:)([^)]+?)\s*\)/gi,
    (_match, inner) => {
      const idx = originals.length;
      originals.push(inner.trim());
      return `url("${URL_PLACEHOLDER_PREFIX}${idx}")`;
    },
  );
  return { masked, originals };
}

function restoreUrls(css: string, originals: string[]): string {
  const escPrefix = URL_PLACEHOLDER_PREFIX.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  return css.replace(
    new RegExp(`url\\(\\s*["']?${escPrefix}(\\d+)["']?\\s*\\)`, "g"),
    (_match, idx) => `url(${originals[Number(idx)]})`,
  );
}

/**
 * 递归内联 CSS 中的 @import 语句，同时将被引入文件中的 url() 相对路径
 * 调整为相对于主文件的路径。这样后续 maskUrls 能遮蔽到所有 url()，
 * 避免 Bun bundler 自行处理并生成不一致的 hash 文件名。
 */
async function inlineImports(
  css: string,
  cssDir: string,
  seen = new Set<string>(),
): Promise<string> {
  const importRegex =
    /@import\s+(?:url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])\s*;/g;
  let result = css;
  let match;
  // 收集所有 import，从后往前替换以保持索引稳定
  const imports: { start: number; end: number; spec: string }[] = [];
  while ((match = importRegex.exec(css)) !== null) {
    const spec = match[1] || match[2];
    if (spec && !spec.startsWith("http://") && !spec.startsWith("https://")) {
      imports.push({
        start: match.index,
        end: match.index + match[0].length,
        spec,
      });
    }
  }
  // 从后往前替换
  for (let i = imports.length - 1; i >= 0; i--) {
    const { start, end, spec } = imports[i];
    const importedPath = join(cssDir, spec);
    if (seen.has(importedPath) || !existsSync(importedPath)) continue;
    seen.add(importedPath);
    const importedDir = dirname(importedPath);
    let importedCss = await Bun.file(importedPath).text();
    // 递归处理嵌套的 @import
    importedCss = await inlineImports(importedCss, importedDir, seen);
    // 调整 url() 相对路径：从 importedDir 相对改为 cssDir 相对
    if (importedDir !== cssDir) {
      importedCss = importedCss.replace(
        /url\(\s*(?!["']?(?:data\s*:|https?:\/\/))([^)]+?)\s*\)/gi,
        (_m, inner) => {
          const trimmed = inner.trim().replace(/^["']|["']$/g, "");
          const abs = join(importedDir, trimmed);
          const rewritten = relative(cssDir, abs);
          return `url("${rewritten}")`;
        },
      );
    }
    result = result.slice(0, start) + importedCss + result.slice(end);
  }
  return result;
}

/**
 * 使用 Bun.build 压缩 CSS 文本（内容已从源文件或 sass 编译结果读入），
 * 返回压缩后的 CSS 文本。为了避开 Bun 对 url() 的强制内联行为，会先把
 * url() 替换成占位符、压缩后再还原。
 */
async function minifyCssViaBun(
  cssSource: string,
  sourceHint: string,
): Promise<string> {
  const { masked, originals } = maskUrls(cssSource);

  // @import 已在 inlineImports() 中被完全内联，Bun.build 不再需要
  // 解析相对路径，所以临时文件可以安全地放在系统临时目录。
  const tmpDir = join(tmpdir(), "biu-css");
  await mkdir(tmpDir, { recursive: true });
  const tmpFile = join(
    tmpDir,
    `.biu-tmp-${basename(sourceHint, extname(sourceHint))}-${
      contentHash(masked + sourceHint + process.pid + Date.now(), 16)
    }.css`,
  );
  await Bun.write(tmpFile, masked);

  try {
    const result = await build({
      entrypoints: [tmpFile],
      minify: true,
      target: "browser",
      throw: true,
    });
    const cssOutput = result.outputs.find((o) => o.path.endsWith(".css"));
    if (!cssOutput) {
      throw new Error(`Bun.build produced no CSS output for ${sourceHint}`);
    }
    // Bun's CSS bundler always appends a trailing newline; strip it so the
    // output matches the tight, single-line style previously produced by
    // clean-css.
    const minified = (await cssOutput.text()).replace(/\n+$/, "");
    return restoreUrls(minified, originals);
  } finally {
    await rm(tmpFile, { force: true });
  }
}

/**
 * 编译 SCSS / 压缩 CSS，返回压缩后的 CSS 文本
 *
 * - `.scss` / `.sass`：先用 sass 编译，再交给 Bun.build 压缩
 * - `.css`：直接读取源文件后交给 Bun.build 压缩
 */
export async function compileStyle(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  let css: string;
  if (ext === ".scss" || ext === ".sass") {
    // sass.compile 自身会处理 @import / @use
    css = sass.compile(filePath).css;
  } else {
    // 对纯 CSS，先递归内联 @import，使所有 url() 统一在主文件层面，
    // 后续 maskUrls 才能完整遮蔽，避免 Bun bundler 生成不一致的 hash。
    css = await Bun.file(filePath).text();
    css = await inlineImports(css, dirname(filePath));
  }
  return await minifyCssViaBun(css, filePath);
}

/**
 * 处理所有 scss / css 文件：编译 → 压缩 → 带 hash 输出
 * 返回 sourceToOutputCss 映射 (源绝对路径 → 输出绝对路径)
 */
export async function processStyleFiles(
  styleFiles: string[],
  srcDir: string,
  outDir: string,
  forceWrite = false,
): Promise<{ map: Map<string, string>; wrote: number }> {
  const sourceToOutputCss = new Map<string, string>();
  let wrote = 0;
  const results = await Promise.all(
    styleFiles.map(async (file) => {
      const css = await compileStyle(file);
      const hash = contentHash(css);
      const name = basename(file).replace(/\.(scss|sass|css)$/, "");
      const outputName = `${name}-${hash}.css`;
      const relDir = dirname(relative(srcDir, file));
      const outputDir = join(outDir, relDir);
      await mkdir(outputDir, { recursive: true });
      const outputPath = join(outputDir, outputName);
      let written = false;
      if (forceWrite || !existsSync(outputPath)) {
        await Bun.write(outputPath, css);
        written = true;
      }
      return [file, outputPath, written] as const;
    }),
  );
  for (const [src, out, written] of results) {
    sourceToOutputCss.set(src, out);
    if (written) wrote++;
  }
  return { map: sourceToOutputCss, wrote };
}
