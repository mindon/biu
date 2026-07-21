// biu — CSS/SCSS compilation & processing

import CleanCSS from "clean-css";
import { build } from "bun";
import * as sass from "sass";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { contentHash, hashAssetCached } from "./utils.ts";

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
 * 与 maskUrls 同理：Bun.build 会尝试解析 CSS 中的 `@import "xxx.css"`，
 * 在临时目录里找不到目标文件就会报 "could not resolve" 错误（或静默丢弃）。
 * biu 希望**原样保留** @import（不内联，交给浏览器/部署环境按路径加载），
 * 所以在 build 之前把 @import 的引用替换成一个 `https://` 假 URL —— Bun 对
 * 外部 scheme 的 @import 会原样保留，不做文件系统解析 —— build 后再还原。
 *
 * 注意：本函数必须在 maskUrls 之前调用，避免 `@import url(...)` 里的 url()
 * 被 maskUrls 先行遮蔽。
 */
const IMPORT_PLACEHOLDER_PREFIX = "https://biu.invalid/import/";

function maskImports(css: string): { masked: string; originals: string[] } {
  const originals: string[] = [];
  const masked = css.replace(
    /@import\s+(url\(\s*["']?[^"')]+["']?\s*\)|["'][^"']+["'])/gi,
    (match, spec) => {
      // 提取实际引用内容，判断是否为外部 URL（外部的无需 mask，Bun 会保留）
      const inner = String(spec)
        .replace(/^url\(\s*/i, "")
        .replace(/\s*\)$/, "")
        .replace(/^["']|["']$/g, "");
      if (/^https?:\/\//i.test(inner)) return match;
      const idx = originals.length;
      originals.push(spec);
      return `@import "${IMPORT_PLACEHOLDER_PREFIX}${idx}"`;
    },
  );
  return { masked, originals };
}

function restoreImports(css: string, originals: string[]): string {
  const escPrefix = IMPORT_PLACEHOLDER_PREFIX.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  return css.replace(
    new RegExp(`@import\\s+["']${escPrefix}(\\d+)["']`, "g"),
    (_match, idx) => `@import ${originals[Number(idx)]}`,
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
  // 先遮蔽 @import（保留而非内联），再遮蔽 url()。顺序不能颠倒，
  // 否则 `@import url(...)` 里的 url() 会被 maskUrls 抢先处理。
  const importMask = maskImports(cssSource);
  const { masked, originals } = maskUrls(importMask.masked);

  // @import 与 url() 都已被替换成外部 https 占位符，Bun.build 不会再尝试
  // 到文件系统解析它们，所以临时文件可以安全地放在系统临时目录。
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
    return restoreImports(
      restoreUrls(minified, originals),
      importMask.originals,
    );
  } finally {
    await rm(tmpFile, { force: true });
  }
}

/**
 * 编译 SCSS / 压缩 CSS，返回压缩后的 CSS 文本
 *
 * - `.scss` / `.sass`：先用 sass 编译，再交给 Bun.build 压缩
 * - `.css`：直接读取源文件后交给 Bun.build 压缩
 *
 * 说明：CSS 中的原生 `@import "xxx.css"` 会被**原样保留**（不内联），
 * 由 minifyCssViaBun 通过占位符绕过 Bun 的路径解析，避免 could-not-resolve。
 * sass 对 `.css` 后缀的 @import 同样保留为原生 CSS @import。
 */
export async function compileStyle(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  let css: string;
  if (ext === ".scss" || ext === ".sass") {
    // sass.compile 自身会处理 SCSS 的 @import / @use（无 .css 后缀的会内联），
    // 对 .css 后缀的 @import 则保留为原生 CSS @import。
    css = sass.compile(filePath).css;
  } else {
    css = await Bun.file(filePath).text();
  }
  return await minifyCssViaBun(css, filePath);
}

/**
 * 收集 CSS 中 url() 所引用的本地资源源文件路径（按 cssDir 解析），
 * 跳过 data: / http(s): / 占位符。返回去重后的相对/绝对路径数组。
 */
function collectCssUrlRefs(css: string, cssDir: string): string[] {
  const refs = new Set<string>();
  const re =
    /url\(\s*(?!["']?(?:data\s*:|https?:\/\/))["']?([^"')]+?)["']?\s*\)/gi;
  for (const m of css.matchAll(re)) {
    const ref = m[1]?.trim();
    if (!ref) continue;
    // 去掉 query / hash
    const clean = ref.replace(/[?#].*$/, "");
    if (!clean) continue;
    refs.add(join(cssDir, clean));
  }
  return Array.from(refs);
}

/**
 * 把 CSS 引用的 asset 源内容指纹拼接到 CSS 自身指纹输入中，
 * 使得 asset 变化 → CSS 产物文件名 hash 变化 → 下游（HTML）随之刷新。
 * 这样在并行管线中也能保证 CSS hash 反映上游 asset 变更。
 */
async function computeStyleHashSeed(
  css: string,
  cssDir: string,
): Promise<string> {
  const refs = collectCssUrlRefs(css, cssDir);
  if (refs.length === 0) return "";
  // 排序保证顺序稳定
  refs.sort();
  // 内层并发 + 全局缓存（hashAssetCached）：
  // 同一 asset 被多个 CSS / JS entry 引用时只读盘 + hash 一次。
  // 不存在的文件 hashAssetCached 返回 null，跳过即可。
  const partsRaw = await Promise.all(
    refs.map(async (ref) => {
      const h = await hashAssetCached(ref);
      return h ? `${basename(ref)}:${h}` : null;
    }),
  );
  return partsRaw.filter((x): x is string => x !== null).join(",");
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
): Promise<{
  map: Map<string, string>;
  wrote: number;
  changed: Set<string>;
}> {
  const sourceToOutputCss = new Map<string, string>();
  const changed = new Set<string>();
  let wrote = 0;
  const results = await Promise.all(
    styleFiles.map(async (file) => {
      const css = await compileStyle(file);
      // 把 CSS 引用到的 asset 内容指纹也纳入 CSS 自身 hash 输入，
      // 否则 asset 改名后 CSS 文件名不变，下游 HTML 也不会刷新缓存。
      const seed = await computeStyleHashSeed(css, dirname(file));
      const hash = contentHash(
        seed ? `${css}\n/*__biu_assets__:${seed}*/` : css,
      );
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
    if (written) {
      wrote++;
      changed.add(src);
    }
  }
  return { map: sourceToOutputCss, wrote, changed };
}
