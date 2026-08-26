// biu — core build logic

import { build } from "bun";
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { ASSET_EXTS, MANAGED_EXTS, VERSION } from "./constants.ts";
import {
  hashAssetCached,
  resetAssetHashCache,
  scan,
  stripJsComments,
} from "./utils.ts";
import { autoInstallDeps } from "./deps.ts";
import type { DependsMode } from "./cli.ts";
import { processStyleFiles } from "./styles.ts";
import { processAssetFiles } from "./assets.ts";
import { createBasePlugin, createMainPlugin } from "./plugins.ts";
import { processHtml } from "./html.ts";
import { collectImportMapSpecifiers } from "./importmaps.ts";
import { rewriteCdnInOutputs, runCdnPipeline } from "./cdn.ts";

/**
 * 单个 JS/TS 源文件的扫描结果。整次构建中每个文件只扫描一次，
 * 跨阶段（resolveDependencies / moduleDeps BFS / asset-ref 收集）共享。
 */
interface FileScan {
  /** 该文件直接 import 的本地 .ts/.js 信息（已解析为绝对路径） */
  imports: Array<{
    abs: string;
    /** 原始 fullPath（含可能的 ?? 或 #/? 后缀）—— 用于判断 force-inline 与 extras */
    raw: string;
    /** #/? 后缀（不含主路径） */
    extra: string;
    /** 是否 force-inline （?? 标记） */
    forceInline: boolean;
  }>;
  /** 该文件中字符串字面量引用的 asset/CSS 等资源（已解析为绝对路径并经 existsSync 过滤） */
  assetRefs: string[];
}

// 匹配相对/根路径的 import / from 语句。
// 故意放宽到"任意非空 specifier"，包括无扩展名形式（如 `import "./hey/auto-inline"`），
// 由 scanner 在解析阶段尝试补全 .ts/.js/.mts/.cts/.mjs/.cjs/index.* 扩展名；
// 不在 jsFileSet 中的目标会被丢弃，因此不会误把 bare specifier 识别为本地 import。
//   - group 1: 主路径（不含 ?# 后缀）—— 必须以 . 或 / 起头
//   - group 2: 后缀（?... 或 #...，可空），其中含 `??` 表示 force-inline
const FILE_IMPORT_TS_RE =
  /(?:import|from)\s+["'](\.{1,2}\/[^"'#?]*|\/[^"'#?]*)([#\?][^"']*)?["']/g;
// 字符串字面量引用的资源后缀。包含 ts/js/mts/mjs 是为了识别"动态加载"
// 模式（如 `s.src = "./a.js"`、`new Worker("./a.ts")`、`loadScript("./a.js")`），
// 这些不会出现在 import/from 里，但其源文件改动应让引用方产物 hash 变化，
// 否则下游产物文件名不变 → updateJsImports 不会重写 → 浏览器请求旧 hash 404。
// 允许路径后带 ?query / #hash 后缀（如 `new URL("./a.ts?world=123")`）：
//   - group 1 仅捕获主路径（不含后缀），交由 resolve() 解析为源文件；
//   - 末尾 `(?:[?#]...)?` 吞掉可空的 query/hash，否则带后缀的引用整体匹配
//     失败 → 该源文件不会被登记为引用方的资源依赖 → 引用方产物 hash 不随
//     其改动变化（下游缓存失效失灵）。
const FILE_STRING_REF_RE =
  /["'`](\.{1,2}\/[^"'`\s?#]+?\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|json|css|scss|sass|[mc]?[jt]s))(?:[?#][^"'`\s]*)?["'`]/gi;

/**
 * 创建文件扫描器：统一一次读盘 + 一次正则扫描，结果缓存复用。
 * jsFileSet: 全部 .ts/.js 源文件集合，用于过滤 imports 是否指向项目内文件。
 */
function createFileScanner(jsFileSet: Set<string>) {
  const cache = new Map<string, Promise<FileScan>>();

  function get(file: string): Promise<FileScan> {
    let p = cache.get(file);
    if (p) return p;
    p = (async (): Promise<FileScan> => {
      if (!existsSync(file)) {
        return { imports: [], assetRefs: [] };
      }
      const code = stripJsComments(await Bun.file(file).text());
      const dir = dirname(file);

      const imports: FileScan["imports"] = [];
      for (const m of code.matchAll(FILE_IMPORT_TS_RE)) {
        const mainPath = m[1];
        const suffix = m[2] ?? "";
        // raw 保留 `?#` 后缀语义（force-inline `??` 由它判定）
        const raw = mainPath + suffix;
        const baseAbs = resolve(dir, mainPath);

        // 解析为项目内的真实源文件：依次尝试
        //   1) 原路径直接命中（带扩展名的常规 import）
        //   2) 无扩展名 → 依次补 .ts / .mts / .cts / .tsx / .js / .mjs / .cjs / .jsx
        //   3) 目录形式 → 补 /index.{ts,js,...}
        // 若用户写了 `.js` 但盘上是 `.ts`（动态化常见），同样按 (2) 的列表替换扩展名。
        let abs: string | null = null;
        if (jsFileSet.has(baseAbs)) {
          abs = baseAbs;
        } else {
          const exts = [
            ".ts",
            ".mts",
            ".cts",
            ".tsx",
            ".js",
            ".mjs",
            ".cjs",
            ".jsx",
          ];
          // 无扩展名 → 直接拼
          const lower = baseAbs.toLowerCase();
          const hasJsLikeExt = /\.[mc]?[jt]sx?$/.test(lower);
          if (!hasJsLikeExt) {
            for (const ext of exts) {
              const cand = baseAbs + ext;
              if (jsFileSet.has(cand)) {
                abs = cand;
                break;
              }
            }
            // 目录形式：./foo → ./foo/index.{ts,...}
            if (!abs) {
              for (const ext of exts) {
                const cand = resolve(baseAbs, `index${ext}`);
                if (jsFileSet.has(cand)) {
                  abs = cand;
                  break;
                }
              }
            }
          } else {
            // 用户写了 .js 但实际是 .ts（动态加载/重命名场景）
            const noExt = baseAbs.replace(/\.[mc]?[jt]sx?$/i, "");
            for (const ext of exts) {
              const cand = noExt + ext;
              if (jsFileSet.has(cand)) {
                abs = cand;
                break;
              }
            }
          }
        }
        if (!abs || abs === file) continue;
        imports.push({
          abs,
          raw,
          extra: suffix,
          forceInline: /\?\?/.test(raw),
        });
      }

      const assetRefs: string[] = [];
      const seen = new Set<string>();
      for (const m of code.matchAll(FILE_STRING_REF_RE)) {
        const spec = m[1];
        const idx = m.index ?? 0;
        const before = code.slice(Math.max(0, idx - 32), idx);
        // 排除前面紧跟 import/from 的（那是模块导入，已由 imports 字段处理）
        if (/(?:import|from)\s*$/i.test(before)) continue;
        let abs = resolve(dir, spec.replace(/[#\?].*$/, ""));
        // 动态加载形式：用户在源码里写 `"./a.js"`/`"./a.mjs"`，但盘上是 `.ts`/`.mts`，
        // 回退到对应 ts 源文件，保证 a.ts 改动能被识别为 b 的资源依赖。
        if (!existsSync(abs)) {
          const lower = abs.toLowerCase();
          let alt: string | null = null;
          if (lower.endsWith(".js")) alt = `${abs.slice(0, -3)}.ts`;
          else if (lower.endsWith(".cjs")) alt = `${abs.slice(0, -4)}.cts`;
          else if (lower.endsWith(".mjs")) alt = `${abs.slice(0, -4)}.mts`;
          if (alt && existsSync(alt)) {
            abs = alt;
          } else {
            continue;
          }
        }
        if (abs === file || seen.has(abs)) continue;
        seen.add(abs);
        assetRefs.push(abs);
      }

      return { imports, assetRefs };
    })();
    cache.set(file, p);
    return p;
  }

  return { get };
}

type FileScanner = ReturnType<typeof createFileScanner>;

/**
 * 递归解析 JS/TS 依赖（基于共享 FileScanner，按 BFS 层并发）。
 *
 * htmlRawContents: 所有 HTML 文件的原始内容拼接字符串。
 * 判断规则：如果某个 ts/js 文件的 basename（如 "name.ts"）在任意 HTML 文件内容中
 * 从未出现过，且它被其他 ts/js import 了，则自动内联到 importer 中；
 * 否则保持为独立模块输出。
 */
async function resolveDependencies(
  initial: string[],
  initialModules: string[],
  scanner: FileScanner,
  htmlRawContents: string,
): Promise<
  {
    entrypoints: string[];
    moduleEntries: string[];
    extras: Record<string, string>;
  }
> {
  const deps = new Set<string>(initial);
  const modules = new Set<string>(initialModules);
  const extras: Record<string, string> = {};

  // BFS：每层并发扫描所有未访问文件的依赖；下层 = 本层新发现的 import 目标。
  const visited = new Set<string>([...initial, ...initialModules]);
  let frontier: string[] = [...initial, ...initialModules];

  while (frontier.length > 0) {
    const scans = await Promise.all(frontier.map((f) => scanner.get(f)));
    const next: string[] = [];
    for (const scan of scans) {
      for (const imp of scan.imports) {
        const { abs, raw, extra, forceInline } = imp;
        if (forceInline) {
          // ?? suffix → force inline 到 importer 中
          // 仅将其加入 deps（使 importer bundle 时包含它）
          // 不从 modules 中移除：如果 HTML 直接引用了它，它仍保留独立模块输出
          deps.add(abs);
        } else {
          const tester = new RegExp(
            `[/'"\`]${basename(abs).replace(/\./g, "\\.")}[?#'"\`]`,
          );
          if (tester.test(htmlRawContents)) {
            // basename 出现在某个 HTML 中 → 独立模块
            modules.add(abs);
            if (extra) extras[abs] = extra;
          } else {
            // basename 未在任何 HTML 中出现 → auto inline
            deps.add(abs);
          }
        }
        if (!visited.has(abs)) {
          visited.add(abs);
          next.push(abs);
        }
        // 哑元用一下 raw，避免 lint 报"未使用"（实际信息已通过 forceInline/extra 提取）
        void raw;
      }
    }
    frontier = next;
  }

  return {
    entrypoints: Array.from(deps),
    moduleEntries: Array.from(modules),
    extras,
  };
}

/**
 * 更新 CSS 产物中的 url() 引用，指向带 hash 的资源文件
 */
async function updateCssUrls(
  sourceToOutputCss: Map<string, string>,
  sourceToOutputAsset: Map<string, string>,
) {
  await Promise.all(
    Array.from(sourceToOutputCss).map(async ([cssSrcFile, cssOutFile]) => {
      let css = await Bun.file(cssOutFile).text();
      let cssChanged = false;
      const cssOutDir = dirname(cssOutFile);
      const cssSrcDir = dirname(cssSrcFile);

      for (const [assetSrcFile, assetOutFile] of sourceToOutputAsset) {
        const relFromCss = relative(cssSrcDir, assetSrcFile);
        const escapedRelPath = relFromCss.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const newCss = css.replace(
          new RegExp(
            `(url\\(["']?)(?:\\.\\/)?${escapedRelPath}(["']?\\))`,
            "g",
          ),
          (match, prefix, suffix) => {
            if (/data\s*:/i.test(match)) return match;
            const relOutput = relative(cssOutDir, assetOutFile);
            return `${prefix}${relOutput}${suffix}`;
          },
        );
        if (newCss !== css) {
          css = newCss;
          cssChanged = true;
        }
      }
      if (cssChanged) {
        await Bun.write(cssOutFile, css);
      }
    }),
  );
}

/**
 * 更新 JS 产物内部的 import 路径 + 资源路径字符串
 */
async function updateJsImports(
  allOutputs: any[],
  sourceToOutput: Map<string, string>,
  moduleAbsPaths: Set<string>,
  sourceToOutputCss: Map<string, string>,
  sourceToOutputAsset: Map<string, string>,
  extras: Record<string, string>,
  moduleInlineFiles?: Map<string, string[]>,
): Promise<Set<string>> {
  const changedOutputs = new Set<string>();
  // 构建产物路径 → 源文件路径的反向映射
  const outputToSource = new Map<string, string>();
  for (const [src, out] of sourceToOutput) {
    outputToSource.set(out, src);
  }

  await Promise.all(
    allOutputs
      .filter((output) => output.path.endsWith(".js"))
      .map(async (output) => {
        let code = await Bun.file(output.path).text();
        let changed = false;

        // (a) 替换 import/from 中的 module 引用路径
        //     force-inline 后，内联代码中的 import 相对路径可能不再正确，
        //     需要基于产物输出位置重新计算完整相对路径
        const jsOutDir = dirname(output.path);
        for (const [srcFile, outputFile] of sourceToOutput) {
          if (!moduleAbsPaths.has(srcFile)) continue;

          const srcBaseName = basename(srcFile).replace(/\.(ts|js)$/, "");
          // 从当前 JS 产物到目标模块产物的正确相对路径
          let correctRelPath = relative(jsOutDir, outputFile);
          if (!correctRelPath.startsWith(".")) {
            correctRelPath = `./${correctRelPath}`;
          }
          const extra = extras?.[srcFile] ?? "";

          // 兜底：替换 import 路径中的 module 引用。
          // 正常情况下 createMainPlugin + 拓扑构建已经让 bun 直接产出
          // 正确的 ./<name>.<hash>.js 引用，无需再处理。
          // 但 force-inline (??) 内联后，被内联代码里如果出现裸的 ./name.js
          // 引用，仍需修正到带 hash 的真实产物。
          const pattern = new RegExp(
            `((?:import|from)\\s*["'])([^"']*?\\/?)(${srcBaseName})(\\.(?:js|ts|mjs))([^"']*)(["'])`,
            "g",
          );

          const newCode = code.replace(
            pattern,
            (_match, prefix, _dir, _name, _ext, _suffix, quote) => {
              return `${prefix}${correctRelPath}${extra}${quote}`;
            },
          );
          if (newCode !== code) {
            code = newCode;
            changed = true;
          }
        }

        // (b) 替换 JS 产物中的字符串路径引用（静态资源 + CSS + JS/TS）
        const jsSrcFile = outputToSource.get(output.path);
        if (jsSrcFile) {
          const jsOutDir = dirname(output.path);

          // 候选"源目录基准"集合：
          //   entry 源文件目录 + 所有传递可达的内联（force-inline）文件目录。
          //   原因：被内联的中转文件里的字符串字面量（如 `new Worker("./w.ts")`）
          //   是按 *它自己的* 源文件目录写的相对路径；合并到 entry 产物后，
          //   仅以 entry 目录为基准计算 relative() 会漏匹配。
          const candidateDirs = new Set<string>([dirname(jsSrcFile)]);
          const inlineFiles = moduleInlineFiles?.get(jsSrcFile);
          if (inlineFiles) {
            for (const f of inlineFiles) candidateDirs.add(dirname(f));
          }

          // 合并所有需要替换的映射
          const allMappings: [string, string][] = [];
          for (const [src, out] of sourceToOutputAsset) {
            allMappings.push([src, out]);
          }
          for (const [src, out] of sourceToOutputCss) {
            allMappings.push([src, out]);
          }
          for (const [src, out] of sourceToOutput) {
            if (src === jsSrcFile) continue;
            allMappings.push([src, out]);
          }

          // 按相对路径长度降序排列，长路径优先匹配
          // （以 entry 目录为基准排序即可，内联候选基准排序差异忽略不计）
          const sortBaseDir = dirname(jsSrcFile);
          allMappings.sort((a, b) =>
            relative(sortBaseDir, b[0]).length -
            relative(sortBaseDir, a[0]).length
          );

          // entry 源目录 — 用于把候选 baseDir 镜像到产物侧。
          // 由于 jsBuild 用 outdir 保留了 src 目录结构（e.g. src/hey/x.ts → dist/hey/x.<hash>.js），
          // 内联文件源目录 baseDir 在产物侧对应的目录就是
          //   outBaseDir = jsOutDir + relative(srcEntryDir, baseDir)
          // 这样替换出的相对路径与原字面量的"路径形状"保持一致，
          // 不会破坏诸如 `base + "./w.ts"` 的字符串拼接语义。
          const srcEntryDir = dirname(jsSrcFile);

          for (const [mappedSrcFile, mappedOutFile] of allMappings) {
            // 对每个候选源目录基准都生成相对路径变体；
            // .ts/.mts/.cts 额外补一份 .js/.mjs/.cjs 形式（用户可能写
            // `s.src="./a.js"` 而源是 a.ts）。
            // 用 (alt → baseDir) 配对：每个变体记住自己的源基准，
            // 改写时按对应基准镜像计算产物侧相对路径。
            // 同一 alt 字符串可能由多个 baseDir 产生，保留最近的（先到先得即可，
            // 因为产物对应路径会一致）。
            const altMap = new Map<string, string>(); // alt → baseDir
            for (const baseDir of candidateDirs) {
              const rel = relative(baseDir, mappedSrcFile);
              if (!rel) continue;
              if (!altMap.has(rel)) altMap.set(rel, baseDir);
              const lower = rel.toLowerCase();
              if (lower.endsWith(".ts")) {
                const a = `${rel.slice(0, -3)}.js`;
                if (!altMap.has(a)) altMap.set(a, baseDir);
              } else if (lower.endsWith(".mts")) {
                const a = `${rel.slice(0, -4)}.mjs`;
                if (!altMap.has(a)) altMap.set(a, baseDir);
              } else if (lower.endsWith(".cts")) {
                const a = `${rel.slice(0, -4)}.cjs`;
                if (!altMap.has(a)) altMap.set(a, baseDir);
              }
            }
            for (const [alt, baseDir] of altMap) {
              const escapedRelPath = alt.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
              );
              // 该 alt 对应的产物侧基准目录（镜像源端 baseDir）。
              const relBase = relative(srcEntryDir, baseDir);
              const outBaseDir = relBase ? join(jsOutDir, relBase) : jsOutDir;
              let relOutput = relative(outBaseDir, mappedOutFile);
              // 同目录下 relative() 返回裸文件名（如 "worker.xxx.js"）。
              // 对于 `new Worker("...")` / `import("...")` / 动态 src 赋值，
              // 浏览器要求 URL 以 ./ ../ / http(s): 开头才稳妥（worker
              // 规范尤其严格），裸文件名在某些环境下会被当成 bare specifier
              // 解析失败。统一补上 "./" 前缀（除非已是 ../ 形式）。
              if (
                !relOutput.startsWith(".") && !relOutput.startsWith("/")
              ) {
                relOutput = `./${relOutput}`;
              }
              // 允许路径后紧跟 ?query / #hash 后缀（如
              //   `new URL("./hey/hello.ts?world=123")`）。
              // 后缀需原样保留：替换为 `./hey/hello.<hash>.js?world=123`。
              // 不允许后缀会导致带 query 的引用整体匹配失败、不被改写。
              const newCode = code.replace(
                new RegExp(
                  `(["'\`])(?:\\.\\/)?${escapedRelPath}((?:[?#][^"'\`]*)?)(["'\`])`,
                  "g",
                ),
                (match, q1, suffix, q2, offset) => {
                  if (
                    offset > 5 &&
                    /data\s*:[^"'`]*$/i.test(
                      code.slice(Math.max(0, offset - 200), offset),
                    )
                  ) {
                    return match;
                  }
                  const before = code.slice(Math.max(0, offset - 50), offset);
                  if (/(?:import|from)\s*$/i.test(before)) {
                    return match;
                  }
                  return `${q1}${relOutput}${suffix}${q2}`;
                },
              );
              if (newCode !== code) {
                code = newCode;
                changed = true;
              }
            }
          }
        }

        if (changed) {
          await Bun.write(output.path, code);
          changedOutputs.add(output.path);
        }
      }),
  );
  return changedOutputs;
}

/**
 * 路径后处理会改变 Bun 生成映射所依据的字节位置；此时移除失效的 map 及其注释，
 * 避免浏览器使用错误映射。未改写的脚本仍保留完整的外部 Source Map。
 */
async function removeInvalidSourceMaps(jsOutputs: Iterable<string>) {
  await Promise.all(Array.from(jsOutputs, async (jsPath) => {
    const mapPath = `${jsPath}.map`;
    if (!existsSync(mapPath)) return;
    const code = await Bun.file(jsPath).text();
    const withoutSourceMap = code.replace(
      /\n?\/\/# sourceMappingURL=[^\n]*(?:\n|$)/,
      "\n",
    );
    await Promise.all([
      withoutSourceMap === code
        ? Promise.resolve()
        : Bun.write(jsPath, withoutSourceMap),
      unlink(mapPath).catch(() => undefined),
    ]);
  }));
}

/**
 * 处理 HTML 文件中的引用替换
 */
async function processHtmlFiles(
  htmlFiles: string[],
  srcDir: string,
  outDir: string,
  sourceToOutput: Map<string, string>,
  sourceToOutputCss: Map<string, string>,
  sourceToOutputAsset: Map<string, string>,
  forceWrite = false,
): Promise<number> {
  let wrote = 0;
  console.log(`\n🌱 HTML Files Processing (${htmlFiles.length}):`);
  await Promise.all(
    htmlFiles.map(async (file) => {
      let content = await processHtml(file);
      console.log(" ", relative(srcDir, file));

      // 4a. 替换 JS 引用
      const htmlSrcDirForJs = dirname(file);
      const targetDirForJs = dirname(file.replace(srcDir, outDir));
      for (const [srcFile, outputFile] of sourceToOutput) {
        const relFromHtml = relative(htmlSrcDirForJs, srcFile);
        const escapedRelPath = relFromHtml.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        content = content.replace(
          new RegExp(
            `(["'])(?:\\.\\/)?${escapedRelPath}([#\\?][^"']*)?(['"])`,
            "g",
          ),
          (_match, q1, extra, q2) => {
            let relOutput = relative(targetDirForJs, outputFile);
            // ES module specifiers (e.g. inline `<script type="module">`'s
            // `import "./foo.ts"`) must start with "/", "./" or "../".
            // For same-directory bare filenames, restore the "./" prefix.
            if (!relOutput.startsWith(".") && !relOutput.startsWith("/")) {
              relOutput = `./${relOutput}`;
            }
            return `${q1}${relOutput}${extra ?? ""}${q2}`;
          },
        );
      }

      // 4b. 替换 CSS/SCSS 引用
      const htmlSrcDirForCss = dirname(file);
      const targetDirForCss = dirname(file.replace(srcDir, outDir));
      for (const [srcFile, outputFile] of sourceToOutputCss) {
        const relFromHtml = relative(htmlSrcDirForCss, srcFile);
        const escapedRelPath = relFromHtml.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        content = content.replace(
          new RegExp(
            `(["'])(?:\\.\\/)?${escapedRelPath}(["'])`,
            "g",
          ),
          (_match, q1, q2) => {
            const relOutput = relative(targetDirForCss, outputFile);
            return `${q1}${relOutput}${q2}`;
          },
        );
      }

      // 4c. 替换静态资源引用
      for (const [srcFile, outputFile] of sourceToOutputAsset) {
        const targetDir = dirname(file.replace(srcDir, outDir));
        const htmlSrcDir = dirname(file);
        const relFromHtml = relative(htmlSrcDir, srcFile);
        const escapedRelPath = relFromHtml.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        content = content.replace(
          new RegExp(
            `(["'])(?:\\.\\/)?${escapedRelPath}(["'])`,
            "g",
          ),
          (match, q1, q2) => {
            const idx = content.indexOf(match);
            if (
              idx > 5 &&
              /data\s*:[^"']*$/i.test(
                content.slice(Math.max(0, idx - 200), idx),
              )
            ) {
              return match;
            }
            const relOutput = relative(targetDir, outputFile);
            return `${q1}${relOutput}${q2}`;
          },
        );
      }

      const targetPath = file.replace(srcDir, outDir);
      await mkdir(dirname(targetPath), { recursive: true });
      // HTML files don't have content hash in their filenames,
      // so we must compare content to decide whether to update.
      let needsWrite = forceWrite || !existsSync(targetPath);
      if (!needsWrite) {
        const existing = await Bun.file(targetPath).text();
        needsWrite = existing !== content;
      }
      if (needsWrite) {
        await Bun.write(targetPath, content);
        wrote++;
      }
    }),
  );
  return wrote;
}

/**
 * 主构建流程
 */
export async function buildProject(
  srcDir: string,
  outDir: string,
  depends?: DependsMode,
  forceWrite = false,
  staticDir?: string | null,
  cdnCacheDir?: string | null,
  offline = false,
  cdnProxyFallback = false,
  sourceMap = false,
) {
  const startTime = performance.now();
  // 清空跨构建的 asset hash 缓存（避免 watch / dev 模式下读到陈旧 hash）
  resetAssetHashCache();
  const allFiles = (await scan(srcDir)).filter((f) =>
    !f.includes("node_modules") && !f.includes("dist")
  );

  const jsFiles = allFiles.filter((f) =>
    f.endsWith(".ts") || f.endsWith(".js")
  );
  const htmlFiles = allFiles.filter((f) => f.endsWith(".html"));
  const styleFiles = allFiles.filter((f) => /\.(scss|sass|css)$/.test(f));
  const assetFiles = allFiles.filter((f) => {
    const ext = extname(f).toLowerCase();
    return !MANAGED_EXTS.has(ext) && ASSET_EXTS.has(ext);
  });

  const htmlContents = await Promise.all(
    htmlFiles.map(async (htmlFile) => ({
      file: htmlFile,
      content: await Bun.file(htmlFile).text(),
    })),
  );
  const importMapSpecifiers = await collectImportMapSpecifiers(
    htmlContents.map((h) => h.content),
    jsFiles,
  );

  // 自动检测并安装缺失的 npm 依赖；import map 已接管的 specifier 跳过。
  await autoInstallDeps(jsFiles, srcDir, depends, importMapSpecifiers);

  // 从 HTML 入口开始分析依赖
  let initialEntries: string[] = [];
  const initialModules: string[] = [];

  // 拼接所有 HTML 原始内容，用于 basename 出现检测
  const htmlRawContents = htmlContents.map((h) => h.content).join("\n");

  for (const { file: htmlFile, content: htmlContent } of htmlContents) {
    const matches = htmlContent.matchAll(
      /(?:src|import|from)\s*[:=]?\s*["'](\.?\/?.*?\.(ts|js)([#\?][^"']*)?)["']/g,
    );
    for (const match of matches) {
      const fullPath = match[1];
      const entry = resolve(
        dirname(htmlFile),
        fullPath.replace(/[#\?].*$/, ""),
      );
      if (jsFiles.includes(entry) && !/\?\?/.test(fullPath)) {
        initialModules.push(entry);
      }
    }
  }

  // 共享文件扫描器：每个 .ts/.js 源文件全程只读盘+解析一次，
  // 跨 resolveDependencies / moduleDeps BFS / asset-ref 收集 三阶段复用。
  const jsFileSet = new Set(jsFiles);
  const scanner = createFileScanner(jsFileSet);

  // 动态加载场景：源码里通过字符串字面量引用 .ts/.js 的文件（如
  //   `new Worker("./worker.ts")`、`s.src = "./a.js"`、`import("./b.ts")`）
  // 不会出现在 import/from 中，需要把被引用的 JS/TS 文件作为独立 module entry
  // 构建（单独产物 + 带 hash 的文件名），否则浏览器会请求裸 .ts，404/MIME 失败。
  // 字符串路径改写到带 hash 的 .js 产物由 updateJsImports 的 (b) 段完成。
  {
    const jsScans = await Promise.all(jsFiles.map((f) => scanner.get(f)));
    for (const s of jsScans) {
      for (const ref of s.assetRefs) {
        if (jsFileSet.has(ref) && !initialModules.includes(ref)) {
          initialModules.push(ref);
        }
      }
    }
  }

  const { entrypoints, moduleEntries, extras } = await resolveDependencies(
    initialEntries,
    initialModules,
    scanner,
    htmlRawContents,
  );

  // 构建 JS/TS
  const sourceToOutput = new Map<string, string>();
  const allOutputs: any[] = [];

  const cleanEntrypoints = entrypoints.filter((e) =>
    !moduleEntries.includes(e)
  );
  const moduleAbsPaths = new Set(moduleEntries);

  // 构建 moduleEntries
  let jsWrote = 0;
  // 记录本次构建中实际被写盘的源文件（用于在 mapping 列表中标注变更项）
  const jsChanged = new Set<string>();

  // ── 分析 module 之间的相互依赖（仅 module → module，用于拓扑排序）──
  // 目的：按依赖拓扑顺序构建，被依赖的先 build，这样 importer 的
  // external 路径可以直接写出"上游的真实 hash 文件名"，从而让上游变化
  // 直接进入下游内容指纹 → 触发 bun 真正重新构建（而不是补丁式替换）。
  const moduleSet = new Set(moduleEntries);
  const moduleDeps = new Map<string, Set<string>>();

  // 取某个文件的"非 force-inline 的本地 .ts/.js import 绝对路径"列表，
  // 走共享 scanner（无重复读盘）
  async function directImportsOf(file: string): Promise<string[]> {
    const s = await scanner.get(file);
    const out: string[] = [];
    for (const imp of s.imports) {
      // force-inline 的不构成 module 间依赖边（其内容会被 bundle 进 importer，
      // 故已经体现在 importer 自身的 hash 中）
      if (imp.forceInline) continue;
      out.push(imp.abs);
    }
    return out;
  }
  // 对每个 module entry：从自身出发做 BFS，遇到 module 加入 deps（不再下钻），
  // 遇到非 module 中转文件（如 auto-inline.ts）继续下钻其 import，
  // 直至找到所有传递可达的 module。这样：
  //   hello.ts → auto-inline.ts(非 module) → world2.ts(module)
  //   会被正确识别为 hello.ts 依赖 world2.ts，从而：
  //   1) 拓扑排序保证 world2 先 build，hello plugin 能拿到 world2 的最新产物名
  //   2) world2 改动 → entryHashSeed 变 → hello bundle hash 跟变
  await Promise.all(
    moduleEntries.map(async (file) => {
      const deps = new Set<string>();
      const visited = new Set<string>([file]);
      const stack: string[] = [...await directImportsOf(file)];
      while (stack.length) {
        const cur = stack.pop()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        if (moduleSet.has(cur)) {
          deps.add(cur);
          // module 是 external 边界，不再下钻其依赖（它自己有自己的 deps 条目）
          continue;
        }
        // 非 module 中转文件：继续展开它的 import
        const next = await directImportsOf(cur);
        for (const n of next) if (!visited.has(n)) stack.push(n);
      }
      moduleDeps.set(file, deps);
    }),
  );

  // ── 预扫每个 module 源码中字符串引用的 asset / CSS 路径 ──
  // 目的：把这些被引用资源的源内容指纹也纳入 entryHashSeed，
  //   让 asset/CSS 改动 → entry 产物 hash 变 → 下游 HTML 自动刷新缓存。
  // 仅扫描字面量字符串路径（如 "./img/foo.png"），跳过 import/from。
  // 同时也扫 entry 经由非 module 中转文件（被 inline）传递可达的 asset 引用，
  // 否则中转文件里的字符串引用变化不会触达 entry 的 hash。
  // 实现：直接复用共享 scanner（同一文件全程仅扫描一次）。
  const moduleAssetRefs = new Map<string, string[]>(); // entry → 引用资源源文件绝对路径数组
  // entry → 所有传递可达的内联文件源路径（含 entry 自身）
  // 用于 updateJsImports (b) 段：内联代码里的字符串字面量是相对各自源文件目录写的，
  // 被合并到上游产物后相对基准变了，只用 entry 目录算相对路径会漏匹配，
  // 必须把每个 inline 文件目录都当成候选基准再扫一次。
  const moduleInlineFiles = new Map<string, string[]>();
  await Promise.all(
    moduleEntries.map(async (file) => {
      const refs = new Set<string>();
      // 起点：entry 自身 + 所有传递可达的非 module 中转文件
      const visited = new Set<string>([file]);
      const inlineFiles: string[] = [file];
      const stack: string[] = [file];
      while (stack.length) {
        const cur = stack.pop()!;
        const next = await directImportsOf(cur);
        for (const n of next) {
          if (visited.has(n)) continue;
          visited.add(n);
          if (moduleSet.has(n)) continue; // module 边界，不再下钻
          inlineFiles.push(n);
          stack.push(n);
        }
      }
      const scans = await Promise.all(inlineFiles.map((f) => scanner.get(f)));
      for (const s of scans) {
        for (const ref of s.assetRefs) refs.add(ref);
      }
      if (refs.size > 0) {
        moduleAssetRefs.set(file, Array.from(refs).sort());
      }
      if (inlineFiles.length > 1) {
        // 仅当 entry 实际有内联中转时记录（节省内存）
        moduleInlineFiles.set(file, inlineFiles);
      }
    }),
  );

  // 字符串字面量（如 `new URL("./hey/hello.ts")`）引用到的【module entry】
  // 构成"产物级"依赖：被引用 module 的产物名（含 hash）会被 updateJsImports
  // 改写进引用方产物内容。若不把它纳入【构建顺序 + hash 种子】，则当被引用
  // module 的传递依赖（如 hello.ts → world.ts）改动时：被引用 module 产物 hash
  // 变了，但引用方的 hash 种子只取被引用 module 的【源码】哈希（未变）→ 引用方
  // 文件名不变 → 缓存失效失灵（产物内容改了但文件名没改、下游 HTML 不刷新）。
  // 解决：把这些边并入拓扑图（被引用 module 先 build），并在种子里改用被引用
  // module 的【产物 basename】（已递归编码其全部传递内容）。
  const assetModuleDeps = new Map<string, Set<string>>();
  for (const [file, refs] of moduleAssetRefs) {
    const mods = new Set(
      refs.filter((r) => moduleSet.has(r) && r !== file),
    );
    if (mods.size > 0) assetModuleDeps.set(file, mods);
  }

  // 合并 import 依赖 + 字符串引用(asset)依赖：拓扑排序与同层并发调度都以此为准，
  // 确保被字符串引用的 module 也先于引用方 build（引用方种子才能取到其产物名）。
  const combinedDeps = new Map<string, Set<string>>();
  for (const file of moduleEntries) {
    const s = new Set<string>(moduleDeps.get(file) ?? []);
    const a = assetModuleDeps.get(file);
    if (a) { for (const d of a) s.add(d); }
    combinedDeps.set(file, s);
  }

  // 拓扑排序（Kahn）：被依赖的排前面；环检测时降级回原顺序
  const sortedModules: string[] = [];
  {
    const indeg = new Map<string, number>();
    const reverse = new Map<string, Set<string>>(); // dep → 依赖它的 importer 集合
    for (const file of moduleEntries) {
      indeg.set(file, 0);
      reverse.set(file, new Set());
    }
    for (const [file, deps] of combinedDeps) {
      indeg.set(file, deps.size);
      for (const d of deps) {
        reverse.get(d)!.add(file);
      }
    }
    const queue: string[] = [];
    for (const [file, n] of indeg) if (n === 0) queue.push(file);
    while (queue.length) {
      const f = queue.shift()!;
      sortedModules.push(f);
      for (const importer of reverse.get(f)!) {
        const n = (indeg.get(importer) ?? 0) - 1;
        indeg.set(importer, n);
        if (n === 0) queue.push(importer);
      }
    }
    if (sortedModules.length !== moduleEntries.length) {
      // 检测到循环依赖：回退到原顺序
      console.warn(
        `⚠️  Circular dependency detected among module entries; ` +
          `falling back to original build order.`,
      );
      sortedModules.length = 0;
      sortedModules.push(...moduleEntries);
    }
  }

  // 已构建产物映射（src 绝对路径 → 产物绝对路径），按拓扑顺序累积；
  // createMainPlugin 通过它把 external 引用写成上游真实文件名（含 hash）
  const moduleOutputs = new Map<string, string>();

  async function buildModules() {
    // 单 entry 构建逻辑（无副作用前提：每个 entry 只写自己 key 到 moduleOutputs/sourceToOutput）
    async function buildOne(file: string) {
      const otherModules = new Set(moduleEntries.filter((m) => m !== file));

      // 收集当前 module 的直接依赖产物文件名作为内容指纹种子；
      // 任意上游产物 hash 变化 → seed 变 → entry 自身产物 hash 变 → 文件名变 → 浏览器/CDN 缓存自动失效。
      // 用 basename 而不是绝对路径，确保移动 dist 目录不影响 hash。
      //
      // ⚠️ 循环依赖场景：拓扑排序失败 → sortedModules 回退到原顺序，
      //    导致 buildOne 执行到 file 时其某些 directDep 还没构建出来
      //    （moduleOutputs.get(dep) === undefined）。
      //    若此时简单跳过未知 dep，seed 会丢失 → entry 产物 hash 不再
      //    跟随上游变化 → 浏览器缓存失效失灵（即用户报告的"index 产物
      //    没有 __biu_upstream__"）。
      //    回退方案：用上游 src 文件的 16 位内容 hash 作为替代项。
      //    源码内容是确定性输入，不受构建顺序影响；上游源码变 → seed 变
      //    → 缓存语义依旧正确。
      const seedParts: string[] = [];
      const directDeps = moduleDeps.get(file);
      if (directDeps && directDeps.size > 0) {
        const upstream: string[] = [];
        const upstreamRaw = await Promise.all(
          Array.from(directDeps).map(async (dep) => {
            const out = moduleOutputs.get(dep);
            if (out) return basename(out);
            // fallback：上游产物未知（循环依赖等），用 src 内容 hash
            const h = await hashAssetCached(dep);
            return h ? `${basename(dep)}~${h}` : null;
          }),
        );
        for (const u of upstreamRaw) if (u) upstream.push(u);
        if (upstream.length > 0) {
          upstream.sort();
          seedParts.push(`m:${upstream.join(",")}`);
        }
      }
      // 把字符串字面量引用的 asset/CSS 源内容指纹也纳入种子，
      // 否则 JS 源码不变但其引用的 asset 改名，JS 产物文件名不变，
      // 引用该 JS 的 HTML 不会刷新 → 浏览器缓存指向的旧 JS 内部仍是旧 asset 名。
      const assetRefs = moduleAssetRefs.get(file);
      if (assetRefs && assetRefs.length > 0) {
        // 内层并发 + 全局缓存（hashAssetCached）：
        // 同一 asset 被多个 entry / CSS 引用时只读盘 + hash 一次。
        const aPartsRaw = await Promise.all(
          assetRefs.map(async (ref) => {
            const h = await hashAssetCached(ref);
            return h ? `${basename(ref)}:${h}` : null;
          }),
        );
        const aParts = aPartsRaw.filter((x): x is string => x !== null);
        if (aParts.length > 0) seedParts.push(`a:${aParts.join(",")}`);
      }
      // 字符串引用到的【module entry】：用其【产物 basename】作种子，
      // 递归编码被引用 module 的全部传递内容（修复其传递依赖改动时引用方
      // 文件名不更新、缓存失效失灵的问题）。拓扑排序已保证被引用 module 先
      // build；个别因环未构建出来的跳过 —— 其源码哈希已由上面的 a: 段覆盖。
      const assetMods = assetModuleDeps.get(file);
      if (assetMods && assetMods.size > 0) {
        const uParts: string[] = [];
        for (const dep of assetMods) {
          const out = moduleOutputs.get(dep);
          if (out) uParts.push(basename(out));
        }
        if (uParts.length > 0) {
          uParts.sort();
          seedParts.push(`u:${uParts.join(",")}`);
        }
      }
      const entryHashSeed = seedParts.length > 0
        ? seedParts.join("|")
        : undefined;

      const plugin = otherModules.size > 0
        ? createMainPlugin(
          otherModules,
          moduleOutputs,
          file,
          entryHashSeed,
          importMapSpecifiers,
        )
        : createBasePlugin(importMapSpecifiers);

      const moduleOutDir = join(outDir, dirname(file.replace(srcDir, "")));

      if (forceWrite) {
        // --force: let bun.build write directly to disk
        const res = await build({
          entrypoints: [file],
          outdir: moduleOutDir,
          minify: true,
          target: "browser",
          naming: "[name].[hash].js",
          sourcemap: sourceMap ? "linked" : "none",
          plugins: [plugin],
        });
        for (const output of res.outputs) {
          allOutputs.push(output);
          if (!output.path.endsWith(".js")) continue;
          sourceToOutput.set(file, output.path);
          moduleOutputs.set(file, output.path);
          jsWrote++;
          jsChanged.add(file);
        }
      } else {
        // Default: use writing:false (without outdir, since Bun ignores
        // writing:false when outdir is set) to get in-memory outputs,
        // then skip writing if the target file already exists on disk.
        // 因为 __biu_upstream__ seed 机制已确保上游变化→hash 变→文件名变，
        // 所以文件名相同意味着源码+上游都没变，产物内容一定正确，直接 skip。
        const res = await build({
          entrypoints: [file],
          minify: true,
          target: "browser",
          naming: "[name].[hash].js",
          sourcemap: sourceMap ? "linked" : "none",
          plugins: [plugin],
          writing: false,
        });
        const outputPaths = res.outputs.map((output) =>
          join(moduleOutDir, basename(output.path))
        );
        const missingJsOutputs = new Set(
          outputPaths.filter((outputPath) =>
            outputPath.endsWith(".js") && !existsSync(outputPath)
          ),
        );
        for (let index = 0; index < res.outputs.length; index++) {
          const output = res.outputs[index];
          // output.path is relative (e.g. "./main.abc12345.js"),
          // resolve it against the intended outdir
          const outputPath = outputPaths[index];
          const isJs = outputPath.endsWith(".js");
          const primaryJsPath = isJs ? outputPath : outputPath.slice(0, -4);
          // 若主 JS 未变但其 map 曾因后处理被移除，不能重新发布一份与最终
          // JS 字节位置不匹配的映射文件。
          const wrote = isJs
            ? missingJsOutputs.has(outputPath)
            : missingJsOutputs.has(primaryJsPath) && !existsSync(outputPath);
          if (wrote) {
            await mkdir(moduleOutDir, { recursive: true });
            await Bun.write(outputPath, output);
          }
          allOutputs.push({ path: outputPath });
          if (!isJs) continue;
          sourceToOutput.set(file, outputPath);
          moduleOutputs.set(file, outputPath);
          if (wrote) {
            jsWrote++;
            jsChanged.add(file);
          }
        }
      }
    }

    // 同层并发拓扑调度：
    //   依赖关系仅约束"上游必须先于下游"；同一层（互不依赖）的 entry 可并发 build。
    //   sortedModules 已是 Kahn 拓扑序（或循环时回退为原顺序），
    //   按"已构建集合是否覆盖其所有依赖"分层。
    const built = new Set<string>();
    let pending = sortedModules.slice();
    while (pending.length > 0) {
      const layer: string[] = [];
      const rest: string[] = [];
      for (const f of pending) {
        const deps = combinedDeps.get(f);
        if (!deps || deps.size === 0) {
          layer.push(f);
        } else {
          let ready = true;
          for (const d of deps) {
            if (moduleSet.has(d) && !built.has(d)) {
              ready = false;
              break;
            }
          }
          (ready ? layer : rest).push(f);
        }
      }
      if (layer.length === 0) {
        // 防御：理论上拓扑序保证不会出现，仅在循环回退场景兜底，
        // 此时按原顺序串行剩余项以保证可完成。
        for (const f of rest) {
          // eslint-disable-next-line no-await-in-loop
          await buildOne(f);
          built.add(f);
        }
        break;
      }
      await Promise.all(layer.map(buildOne));
      for (const f of layer) built.add(f);
      pending = rest;
    }
  }

  // ── 并行阶段 1：JS build / CSS 编译 / Asset 复制 三路并行 ──
  const [, cssResult, assetResult] = await Promise.all([
    buildModules(),
    processStyleFiles(styleFiles, srcDir, outDir, forceWrite),
    processAssetFiles(assetFiles, srcDir, outDir, forceWrite),
  ]);
  const sourceToOutputCss = cssResult.map;
  const sourceToOutputAsset = assetResult.map;
  const cssChanged = cssResult.changed;
  const assetChanged = assetResult.changed;

  // mapping 列表中：变化的项前面带 "*"，未变化的用 " "（对齐）
  const mark = (changed: boolean) => (changed ? "*" : " ");

  console.log(
    `📜 Source -> Output mapping (${sourceToOutput.size} JS, ${jsChanged.size} changed):`,
  );
  for (const [src, out] of sourceToOutput) {
    console.log(
      ` ${mark(jsChanged.has(src))} ${relative(srcDir, src)} -> ${
        relative(outDir, out)
      }`,
    );
  }
  if (sourceToOutputCss.size > 0) {
    console.log(
      `\n🎨 Source -> Output mapping (${sourceToOutputCss.size} CSS, ${cssChanged.size} changed):`,
    );
    for (const [src, out] of sourceToOutputCss) {
      console.log(
        ` ${mark(cssChanged.has(src))} ${relative(srcDir, src)} -> ${
          relative(outDir, out)
        }`,
      );
    }
  }
  if (sourceToOutputAsset.size > 0) {
    console.log(
      `\n📦 Source -> Output mapping (${sourceToOutputAsset.size} Assets, ${assetChanged.size} changed):`,
    );
    for (const [src, out] of sourceToOutputAsset) {
      console.log(
        ` ${mark(assetChanged.has(src))} ${relative(srcDir, src)} -> ${
          relative(outDir, out)
        }`,
      );
    }
  }

  // ── 并行阶段 2：CSS url() 替换 + JS import 路径替换 并行 ──
  const [, rewrittenJsOutputs] = await Promise.all([
    updateCssUrls(sourceToOutputCss, sourceToOutputAsset),
    updateJsImports(
      allOutputs,
      sourceToOutput,
      moduleAbsPaths,
      sourceToOutputCss,
      sourceToOutputAsset,
      extras,
      moduleInlineFiles,
    ),
  ]);
  if (sourceMap) await removeInvalidSourceMaps(rewrittenJsOutputs);

  // ── 并行阶段 3：多个 HTML 文件并行处理引用替换 ──
  const htmlWrote = await processHtmlFiles(
    htmlFiles,
    srcDir,
    outDir,
    sourceToOutput,
    sourceToOutputCss,
    sourceToOutputAsset,
    forceWrite,
  );

  // ── CDN 缓存阶段（可选） ──
  // 收集源码中引用的所有 https:// CDN URL（HTML / CSS / JS / TS / importmap），
  // 递归下载到本地缓存目录；构建产物中所有字面量 CDN URL 改写为
  // /cdn/<host>/<path>，并向 HTML <head> 注入运行时 shim 处理动态加载。
  let cdnSummary:
    | { discovered: number; cached: number; copied: number }
    | null = null;
  if (cdnCacheDir) {
    try {
      const pipe = await runCdnPipeline(
        htmlContents,
        styleFiles,
        jsFiles,
        { cacheDir: cdnCacheDir, outDir, offline },
      );
      const rew = await rewriteCdnInOutputs(
        outDir,
        pipe.manifest,
        cdnProxyFallback,
      );
      if (sourceMap) await removeInvalidSourceMaps(rew.changedJs);
      cdnSummary = {
        discovered: pipe.discovered,
        cached: pipe.cached,
        copied: pipe.copied,
      };
      if (pipe.discovered > 0) {
        console.log(
          `\n☁️  CDN cache: discovered=${pipe.discovered}, cached=${pipe.cached}, ` +
            `copied=${pipe.copied}, rewrote html=${rew.html} css=${rew.css} js=${rew.js}` +
            (offline ? " (offline)" : ""),
        );
      }
    } catch (err) {
      console.warn(`⚠️  CDN cache phase error: ${(err as Error).message}`);
    }
  }
  void cdnSummary;

  // ── 检查引用的资源路径是否存在 ──
  // 收集 src/ 中所有文件引用的资源路径（非 data:/http:/https:），
  // 如果引用的文件既不在 src/ 中也不在 static/ 目录中，发出 warning。
  {
    const warnings: string[] = [];
    const knownFiles = new Set(allFiles);
    const resolvedStaticDir = staticDir ?? undefined;

    // 从 HTML 文件中提取 src/href 引用的非 JS/CSS 资源
    for (const { file, content } of htmlContents) {
      const htmlDir = dirname(file);
      const refs = content.matchAll(
        /(?:src|href)\s*=\s*["']([^"']+)["']/gi,
      );
      for (const m of refs) {
        const ref = m[1];
        if (!ref || /^(data:|https?:|\/\/|#)/.test(ref)) continue;
        // 去掉 query/hash
        const clean = ref.replace(/[?#].*$/, "");
        const ext = extname(clean).toLowerCase();
        // 跳过已被其他处理流程管理的类型
        if (MANAGED_EXTS.has(ext)) continue;
        if (!ASSET_EXTS.has(ext)) continue;
        const abs = resolve(htmlDir, clean);
        if (knownFiles.has(abs)) continue;
        // 检查 static/ 中是否有对应文件
        // 引用的是相对于 HTML 在 dist 中的位置；static/ 会被整体复制到 outDir
        // 所以需要计算：HTML 输出位置相对 outDir 的相对路径 + 引用路径 → 在 static 中的路径
        const htmlRelDir = dirname(relative(srcDir, file));
        const expectedInOut = join(htmlRelDir, clean); // 相对于 outDir 的路径
        const inStatic = resolvedStaticDir
          ? join(resolvedStaticDir, expectedInOut)
          : null;
        if (inStatic && existsSync(inStatic)) continue;
        // 也尝试直接用 clean 作为 static 下的路径（兼容直接引用 outDir 根级文件的情况）
        const inStaticDirect = resolvedStaticDir
          ? join(resolvedStaticDir, clean)
          : null;
        if (inStaticDirect && existsSync(inStaticDirect)) continue;
        warnings.push(
          `  ${relative(srcDir, file)}: "${ref}" → missing`,
        );
      }
    }

    // 从 CSS/SCSS 文件中提取 url() 引用
    for (const file of styleFiles) {
      const cssDir = dirname(file);
      const content = await Bun.file(file).text();
      const urlRefs = content.matchAll(
        /url\(\s*(?!["']?(?:data\s*:|https?:\/\/))["']?([^"')]+?)["']?\s*\)/gi,
      );
      for (const m of urlRefs) {
        const ref = m[1].replace(/[?#].*$/, "");
        if (!ref) continue;
        const abs = resolve(cssDir, ref);
        if (knownFiles.has(abs) || existsSync(abs)) continue;
        // 检查 static/
        const cssRelDir = dirname(relative(srcDir, file));
        const expectedInOut = join(cssRelDir, ref);
        const inStatic = resolvedStaticDir
          ? join(resolvedStaticDir, expectedInOut)
          : null;
        if (inStatic && existsSync(inStatic)) continue;
        const inStaticDirect = resolvedStaticDir
          ? join(resolvedStaticDir, ref)
          : null;
        if (inStaticDirect && existsSync(inStaticDirect)) continue;
        warnings.push(
          `  ${relative(srcDir, file)}: url("${ref}") → missing`,
        );
      }
    }

    // 从 JS/TS 源文件中提取 web-root 引用（以 "/" 起头的 specifier，
    // 例如 `import "/simple.js"`、`new Worker("/worker.ts")`、
    // `loadScript("/x.js")`）。biu 把它们作为 external 交给浏览器按部署
    // 根（即 `static/` 复制后的位置）解析；这里校验对应文件是否存在于
    // `static/`，否则在运行时会 404，提前警告。
    if (resolvedStaticDir) {
      // 字符串里以 "/" 起头的相对部署根路径；排除 //host (protocol-relative)、
      // 路径中包含空格、以及特殊扩展（数据 URI 之类已被起头字符过滤掉了）。
      const ROOT_REF_RE =
        /["'`](\/[A-Za-z0-9_./~@-][^"'`\s?#]*)(?:[?#][^"'`]*)?["'`]/g;
      const seenRootRef = new Set<string>();
      for (const file of jsFiles) {
        const code = stripJsComments(await Bun.file(file).text());
        for (const m of code.matchAll(ROOT_REF_RE)) {
          const ref = m[1];
          // 过滤明显非资源的文本：必须有扩展名或目录形式，且不是双斜杠开头
          if (ref.startsWith("//")) continue;
          // 只关心带可识别扩展名的（避免误报路径形式的字符串常量）
          const ext = extname(ref).toLowerCase();
          if (!ext) continue;
          // ts/mts/cts → 在产物中会变为对应 js（用户写 /worker.ts，运行时
          // 浏览器实际请求需要 /worker.<hash>.js；这超出本校验范围，跳过）
          if (/^\.[mc]?[jt]sx?$/.test(ext)) {
            // js / mjs / cjs：直接落到 static/<path>，可校验
            if (!/^\.[mc]?js$/.test(ext)) continue;
          } else if (!ASSET_EXTS.has(ext)) {
            continue;
          }
          if (seenRootRef.has(`${file}::${ref}`)) continue;
          seenRootRef.add(`${file}::${ref}`);
          // 部署根 → static/ 下相同子路径
          const inStatic = join(resolvedStaticDir, ref);
          if (existsSync(inStatic)) continue;
          warnings.push(
            `  ${relative(srcDir, file)}: "${ref}" → missing in static/`,
          );
        }
      }
    }

    if (
      warnings.length > 0 &&
      /^(?:true|1|yes)$/i.test(process.env.BIU_WARNING?.trim() ?? "")
    ) {
      console.warn(
        `\n⚠️  Warning: ${warnings.length} asset reference(s) in src/ not found in src/ or static/:`,
      );
      for (const w of warnings) console.warn(w);
    }
  }

  // ── 清理上一轮 biu 自己生成的孤儿产物 ──
  // 不再根据 hash 样式猜测文件归属：CDN 镜像、post-build 及外部工具产物也常
  // 使用带 hash 的命名。清单只记录 biu 本轮实际写入的文件，下一轮仅删除清单
  // 中已不再生成的路径；首次启用时没有历史清单，保守地不删除既有文件。
  let cleaned = 0;
  try {
    if (existsSync(outDir)) {
      const outputRoot = resolve(outDir);
      const manifestPath = join(outputRoot, ".biu", "outputs.json");
      const toOutputRelative = (path: string): string | null => {
        const absolute = resolve(path);
        const rel = relative(outputRoot, absolute);
        return !rel || isAbsolute(rel) || /^\.\.(?:[\\/]|$)/.test(rel)
          ? null
          : rel;
      };
      const fromOutputRelative = (rel: string): string | null => {
        const absolute = resolve(outputRoot, rel);
        return toOutputRelative(absolute) === rel ? absolute : null;
      };

      const previousOwned = new Set<string>();
      if (existsSync(manifestPath)) {
        try {
          const manifest = await Bun.file(manifestPath).json() as {
            outputs?: unknown;
          };
          if (Array.isArray(manifest.outputs)) {
            for (const output of manifest.outputs) {
              if (
                typeof output === "string" &&
                fromOutputRelative(output)
              ) {
                previousOwned.add(output);
              }
            }
          }
        } catch {
          // 清单损坏时不做猜测性删除；本轮会在构建结束后安全重建它。
        }
      }

      const currentOwned = new Set<string>();
      const recordCurrentOutput = (path: string) => {
        const rel = toOutputRelative(path);
        if (rel && existsSync(resolve(path))) currentOwned.add(rel);
      };
      for (const p of sourceToOutput.values()) recordCurrentOutput(p);
      for (const p of sourceToOutputCss.values()) recordCurrentOutput(p);
      for (const p of sourceToOutputAsset.values()) recordCurrentOutput(p);
      for (const o of allOutputs) if (o?.path) recordCurrentOutput(o.path);
      for (const f of htmlFiles) recordCurrentOutput(f.replace(srcDir, outDir));

      // 上游 HTML 仍直接引用的下游 CSS / JS 不清理。仅延续清单中已知的
      // biu 产物所有权，避免将用户或外部工具的文件纳入未来删除范围。
      const htmlReferenced = new Set<string>();
      await Promise.all(htmlFiles.map(async (file) => {
        const outputHtml = file.replace(srcDir, outDir);
        if (!existsSync(outputHtml)) return;
        const content = await Bun.file(outputHtml).text();
        for (
          const match of content.matchAll(
            /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi,
          )
        ) {
          const ref = match[1];
          if (!ref || /^(?:data:|https?:|\/\/|#)/i.test(ref)) continue;
          const clean = ref.replace(/[?#].*$/, "");
          if (!/^\.(?:css|[cm]?js)$/i.test(extname(clean))) continue;
          const output = clean.startsWith("/")
            ? resolve(outputRoot, `.${clean}`)
            : resolve(dirname(outputHtml), clean);
          const rel = toOutputRelative(output);
          if (rel && existsSync(output)) htmlReferenced.add(rel);
        }
      }));

      const nextOwned = new Set(currentOwned);
      for (const rel of previousOwned) {
        if (htmlReferenced.has(rel)) nextOwned.add(rel);
      }

      // 当前 static/ 路径始终由静态目录负责，不能作为旧 biu 产物删除。
      const staticRelPaths = new Set<string>();
      if (staticDir && existsSync(staticDir)) {
        for (const sf of await scan(staticDir)) {
          staticRelPaths.add(relative(staticDir, sf));
        }
      }

      const toDelete: string[] = [];
      for (const rel of previousOwned) {
        if (nextOwned.has(rel) || staticRelPaths.has(rel)) continue;
        const output = fromOutputRelative(rel);
        if (output && existsSync(output)) toDelete.push(output);
      }
      const results = await Promise.all(
        toDelete.map((file) => unlink(file).then(() => true, () => false)),
      );
      cleaned = results.reduce((n, ok) => n + (ok ? 1 : 0), 0);

      await mkdir(dirname(manifestPath), { recursive: true });
      await Bun.write(
        manifestPath,
        `${
          JSON.stringify(
            { version: 1, outputs: [...nextOwned].sort() },
            null,
            2,
          )
        }\n`,
      );
    }
  } catch (err) {
    console.warn(`⚠️  Cleanup warning: ${(err as Error).message}`);
  }

  // ── 构建完成摘要 ──
  const now = new Date();
  const ts = now.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: string[] = [];
  if (moduleEntries.length) {
    parts.push(`📜 js=${jsWrote}/${moduleEntries.length}`);
  }
  if (styleFiles.length) {
    parts.push(`🎨 css=${cssResult.wrote}/${styleFiles.length}`);
  }
  if (assetFiles.length) {
    parts.push(`📦 asset=${assetResult.wrote}/${assetFiles.length}`);
  }
  if (htmlFiles.length) parts.push(`🌱 html=${htmlWrote}/${htmlFiles.length}`);
  // if (cleaned > 0) parts.push(`🧹 cleaned=${cleaned}`);
  const total = jsWrote + cssResult.wrote + assetResult.wrote + htmlWrote;
  const elapsed = performance.now() - startTime;
  const duration = elapsed < 1000
    ? `${elapsed.toFixed(0)}ms`
    : `${(elapsed / 1000).toFixed(2)}s`;
  console.log(
    `\n${VERSION}\n⌯⌲ update ${total} file(s)${
      parts.length ? `: ${parts.join(", ")}` : ""
    }\n⊹  ${ts}  ⏱ ${duration}`,
  );
}
