// biu — CSS/SCSS compilation & processing

import CleanCSS from "clean-css";
import { build } from "bun";
import * as sass from "sass";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
 * 使用 Bun.build 压缩 CSS 文本（内容已从源文件或 sass 编译结果读入），
 * 返回压缩后的 CSS 文本。为了避开 Bun 对 url() 的强制内联行为，会先把
 * url() 替换成占位符、压缩后再还原。
 */
async function minifyCssViaBun(
  cssSource: string,
  sourceHint: string,
): Promise<string> {
  const { masked, originals } = maskUrls(cssSource);

  // 把遮蔽后的 CSS 写到系统临时目录，避免污染源目录、也避免递归 scan
  // 在下一次构建时把临时文件误认作源文件。
  const tmpDir = join(tmpdir(), "biu-css");
  await mkdir(tmpDir, { recursive: true });
  const tmpFile = join(
    tmpDir,
    `${basename(sourceHint, extname(sourceHint))}-${
      contentHash(masked + sourceHint + process.pid + Date.now(), 16)
    }.css`,
  );
  await writeFile(tmpFile, masked);

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
  const css = ext === ".scss" || ext === ".sass"
    ? sass.compile(filePath).css
    : await readFile(filePath, "utf8");
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
): Promise<Map<string, string>> {
  const sourceToOutputCss = new Map<string, string>();
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
      await writeFile(outputPath, css);
      return [file, outputPath] as const;
    }),
  );
  for (const [src, out] of results) {
    sourceToOutputCss.set(src, out);
  }
  return sourceToOutputCss;
}
