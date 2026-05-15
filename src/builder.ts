// biu — core build logic

import { build } from "bun";
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { ASSET_EXTS, MANAGED_EXTS, VERSION } from "./constants.ts";
import { hashAssetCached, resetAssetHashCache, scan } from "./utils.ts";
import { autoInstallDeps } from "./deps.ts";
import type { DependsMode } from "./cli.ts";
import { processStyleFiles } from "./styles.ts";
import { processAssetFiles } from "./assets.ts";
import { basePlugin, createMainPlugin } from "./plugins.ts";
import { processHtml } from "./html.ts";

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

const FILE_IMPORT_TS_RE =
  /(?:import|from)\s+["'](\.?\/?.*?\.(ts|js)([#\?][^"']*)?)["']/g;
const FILE_STRING_REF_RE =
  /["'`](\.{1,2}\/[^"'`\s]+?\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|json|css|scss|sass))["'`]/gi;

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
      const code = await Bun.file(file).text();
      const dir = dirname(file);

      const imports: FileScan["imports"] = [];
      for (const m of code.matchAll(FILE_IMPORT_TS_RE)) {
        const raw = m[1];
        const cleanSpec = raw.replace(/[#\?].*$/, "");
        const abs = resolve(dir, cleanSpec);
        if (!jsFileSet.has(abs) || abs === file) continue;
        imports.push({
          abs,
          raw,
          extra: m[3] ?? "",
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
        const abs = resolve(dir, spec.replace(/[#\?].*$/, ""));
        if (abs === file || seen.has(abs)) continue;
        if (!existsSync(abs)) continue;
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
) {
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
          const jsSrcDir = dirname(jsSrcFile);
          const jsOutDir = dirname(output.path);

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
          allMappings.sort((a, b) =>
            relative(jsSrcDir, b[0]).length - relative(jsSrcDir, a[0]).length
          );

          for (const [mappedSrcFile, mappedOutFile] of allMappings) {
            const relFromJs = relative(jsSrcDir, mappedSrcFile);
            const escapedRelPath = relFromJs.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&",
            );
            const newCode = code.replace(
              new RegExp(
                `(["'\`])(?:\\.\\/)?${escapedRelPath}(["'\`])`,
                "g",
              ),
              (match, q1, q2, offset) => {
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
                const relOutput = relative(jsOutDir, mappedOutFile);
                return `${q1}${relOutput}${q2}`;
              },
            );
            if (newCode !== code) {
              code = newCode;
              changed = true;
            }
          }
        }

        if (changed) {
          await Bun.write(output.path, code);
        }
      }),
  );
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

  // 自动检测并安装缺失的 npm 依赖
  await autoInstallDeps(jsFiles, srcDir, depends);

  // 从 HTML 入口开始分析依赖
  let initialEntries: string[] = [];
  const initialModules: string[] = [];

  const htmlContents = await Promise.all(
    htmlFiles.map(async (htmlFile) => ({
      file: htmlFile,
      content: await Bun.file(htmlFile).text(),
    })),
  );
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

  // 拓扑排序（Kahn）：被依赖的排前面；环检测时降级回原顺序
  const sortedModules: string[] = [];
  {
    const indeg = new Map<string, number>();
    const reverse = new Map<string, Set<string>>(); // dep → 依赖它的 importer 集合
    for (const file of moduleEntries) {
      indeg.set(file, 0);
      reverse.set(file, new Set());
    }
    for (const [file, deps] of moduleDeps) {
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

  // ── 预扫每个 module 源码中字符串引用的 asset / CSS 路径 ──
  // 目的：把这些被引用资源的源内容指纹也纳入 entryHashSeed，
  //   让 asset/CSS 改动 → entry 产物 hash 变 → 下游 HTML 自动刷新缓存。
  // 仅扫描字面量字符串路径（如 "./img/foo.png"），跳过 import/from。
  // 同时也扫 entry 经由非 module 中转文件（被 inline）传递可达的 asset 引用，
  // 否则中转文件里的字符串引用变化不会触达 entry 的 hash。
  // 实现：直接复用共享 scanner（同一文件全程仅扫描一次）。
  const moduleAssetRefs = new Map<string, string[]>(); // entry → 引用资源源文件绝对路径数组
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
    }),
  );

  async function buildModules() {
    // 单 entry 构建逻辑（无副作用前提：每个 entry 只写自己 key 到 moduleOutputs/sourceToOutput）
    async function buildOne(file: string) {
      const otherModules = new Set(moduleEntries.filter((m) => m !== file));

      // 收集当前 module 的直接依赖产物文件名作为内容指纹种子；
      // 任意上游产物 hash 变化 → seed 变 → entry 自身产物 hash 变 → 文件名变 → 浏览器/CDN 缓存自动失效。
      // 用 basename 而不是绝对路径，确保移动 dist 目录不影响 hash。
      const seedParts: string[] = [];
      const directDeps = moduleDeps.get(file);
      if (directDeps && directDeps.size > 0) {
        const upstream: string[] = [];
        for (const dep of directDeps) {
          const out = moduleOutputs.get(dep);
          if (out) upstream.push(basename(out));
        }
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
      const entryHashSeed = seedParts.length > 0
        ? seedParts.join("|")
        : undefined;

      const plugin = otherModules.size > 0
        ? createMainPlugin(otherModules, moduleOutputs, file, entryHashSeed)
        : basePlugin;

      const moduleOutDir = join(outDir, dirname(file.replace(srcDir, "")));

      if (forceWrite) {
        // --force: let bun.build write directly to disk
        const res = await build({
          entrypoints: [file],
          outdir: moduleOutDir,
          minify: true,
          target: "browser",
          naming: "[name].[hash].js",
          plugins: [plugin],
        });
        for (const output of res.outputs) {
          allOutputs.push(output);
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
          plugins: [plugin],
          writing: false,
        });
        for (const output of res.outputs) {
          // output.path is relative (e.g. "./main.abc12345.js"),
          // resolve it against the intended outdir
          const outputPath = join(moduleOutDir, basename(output.path));
          if (!existsSync(outputPath)) {
            await mkdir(moduleOutDir, { recursive: true });
            await Bun.write(outputPath, output);
            jsWrote++;
            jsChanged.add(file);
          }
          allOutputs.push({ path: outputPath });
          sourceToOutput.set(file, outputPath);
          moduleOutputs.set(file, outputPath);
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
        const deps = moduleDeps.get(f);
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
  await Promise.all([
    updateCssUrls(sourceToOutputCss, sourceToOutputAsset),
    updateJsImports(
      allOutputs,
      sourceToOutput,
      moduleAbsPaths,
      sourceToOutputCss,
      sourceToOutputAsset,
      extras,
    ),
  ]);

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
        const ref = m[1].replace(/[?#].*$/, '');
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
          `  ${
            relative(srcDir, file)
          }: url("${ref}") → missing`,
        );
      }
    }

    if (warnings.length > 0) {
      console.warn(
        `\n⚠️  Warning: ${warnings.length} asset reference(s) in src/ not found in src/ or static/:`,
      );
      for (const w of warnings) console.warn(w);
    }
  }

  // ── 清理 dist/ 中的孤儿 hash 产物 ──
  // 当上游文件改变后，下游产物的 content hash 也会改变 → 旧 hash 文件成为孤儿。
  // 这里识别并删除：文件名带 hash 但不在本次构建的输出集合中的产物。
  // 安全保护：跳过 static/ 中存在的同路径文件、HTML 文件、未带 hash 模式的文件。
  let cleaned = 0;
  try {
    if (existsSync(outDir)) {
      // 收集本次构建所有合法输出（绝对路径）
      const validOutputs = new Set<string>();
      for (const p of sourceToOutput.values()) validOutputs.add(p);
      for (const p of sourceToOutputCss.values()) validOutputs.add(p);
      for (const p of sourceToOutputAsset.values()) validOutputs.add(p);
      for (const o of allOutputs) {
        if (o?.path) validOutputs.add(o.path);
      }
      // HTML 输出位置也需要保护（HTML 不带 hash，但显式列出更稳妥）
      for (const f of htmlFiles) {
        validOutputs.add(f.replace(srcDir, outDir));
      }

      // 收集 staticDir 下所有相对路径，用于保护被 copyStaticDir 复制过来的文件
      const staticRelPaths = new Set<string>();
      if (staticDir && existsSync(staticDir)) {
        for (const sf of await scan(staticDir)) {
          staticRelPaths.add(relative(staticDir, sf));
        }
      }

      // hash 模式：
      //   JS:        name.HASH.js     (e.g. main.s5aj6zwp.js)
      //   CSS/Asset: name-HASH.ext    (e.g. styles-d4496399.css, mindon-3dadbdab.png)
      //   hash 长度 6-32，字母数字
      const HASH_DOT_RE = /\.[a-z0-9]{6,32}\.(js|mjs|css)$/i;
      const HASH_DASH_RE = /-[a-z0-9]{6,32}\.[a-z0-9]+$/i;

      const distFiles = await scan(outDir);
      // 先筛出待删除候选，再 Promise.all 并发 unlink（IO 并发收益）
      const toDelete: string[] = [];
      for (const f of distFiles) {
        if (validOutputs.has(f)) continue;
        const rel = relative(outDir, f);
        if (staticRelPaths.has(rel)) continue;
        const base = basename(f);
        const isHashed = HASH_DOT_RE.test(base) || HASH_DASH_RE.test(base);
        if (!isHashed) continue;
        toDelete.push(f);
      }
      const results = await Promise.all(
        toDelete.map((f) => unlink(f).then(() => true, () => false)),
      );
      cleaned = results.reduce((n, ok) => n + (ok ? 1 : 0), 0);
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
