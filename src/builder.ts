// biu — core build logic

import { build } from "bun";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { ASSET_EXTS, MANAGED_EXTS, VERSION } from "./constants.ts";
import { scan } from "./utils.ts";
import { autoInstallDeps } from "./deps.ts";
import type { DependsMode } from "./cli.ts";
import { processStyleFiles } from "./styles.ts";
import { processAssetFiles } from "./assets.ts";
import { basePlugin, createMainPlugin } from "./plugins.ts";
import { processHtml } from "./html.ts";

/**
 * 递归解析 JS/TS 依赖
 *
 * htmlRawContents: 所有 HTML 文件的原始内容拼接字符串。
 * 判断规则：如果某个 ts/js 文件的 basename（如 "name.ts"）在任意 HTML 文件内容中
 * 从未出现过，且它被其他 ts/js import 了，则自动内联到 importer 中；
 * 否则保持为独立模块输出。
 */
async function resolveDependencies(
  initial: string[],
  initialModules: string[],
  jsFiles: string[],
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
  const queue = [...initial, ...initialModules];
  const extras: Record<string, string> = {};

  for (const file of queue) {
    const code = await Bun.file(file).text();
    const imports = code.matchAll(
      /(?:import|from)\s+["'](\.?\/?.*?\.(ts|js)([#\?][^"']*)?)["']/g,
    );
    for (const match of imports) {
      const fullPath = match[1];
      const depPath = resolve(
        dirname(file),
        fullPath.replace(/[#\?].*$/, ""),
      );
      if (jsFiles.includes(depPath)) {
        const tester = new RegExp(
          `[/'"\`]${basename(depPath).replace(/\./g, "\\.")}[?#'"\`]`,
        );
        if (/\?\?/.test(fullPath)) {
          // ?? suffix → force inline 到 importer 中
          // 仅将其加入 deps（使 importer bundle 时包含它）
          // 不从 modules 中移除：如果 HTML 直接引用了它，它仍保留独立模块输出
          deps.add(depPath);
        } else if (tester.test(htmlRawContents)) {
          // basename 出现在某个 HTML 中 → 独立模块
          modules.add(depPath);
          if (match[3]) extras[depPath] = match[3];
        } else {
          // basename 未在任何 HTML 中出现 → auto inline
          deps.add(depPath);
        }
        if (!queue.includes(depPath)) queue.push(depPath);
      }
    }
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

          const pattern = new RegExp(
            `((?:import|from)\\s*["'])([^"']*?\\/?)(${srcBaseName})(\\.(?:js|ts))([^"']*)(["'])`,
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
            const relOutput = relative(targetDirForJs, outputFile);
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

  const { entrypoints, moduleEntries, extras } = await resolveDependencies(
    initialEntries,
    initialModules,
    jsFiles,
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
  async function buildModules() {
    for (const file of moduleEntries) {
      const otherModules = new Set(moduleEntries.filter((m) => m !== file));
      const plugin = otherModules.size > 0
        ? createMainPlugin(otherModules)
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
          jsWrote++;
        }
      } else {
        // Default: use writing:false (without outdir, since Bun ignores
        // writing:false when outdir is set) to get in-memory outputs,
        // then skip writing if the target file already exists on disk.
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
          await mkdir(moduleOutDir, { recursive: true });
          if (!existsSync(outputPath)) {
            await Bun.write(outputPath, output);
            jsWrote++;
          }
          allOutputs.push({ path: outputPath });
          sourceToOutput.set(file, outputPath);
        }
      }
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

  console.log(`📜 Source -> Output mapping (${sourceToOutput.size} JS):`);
  for (const [src, out] of sourceToOutput) {
    console.log(`  ${relative(srcDir, src)} -> ${relative(outDir, out)}`);
  }
  if (sourceToOutputCss.size > 0) {
    console.log(
      `\n🎨 Source -> Output mapping (${sourceToOutputCss.size} CSS):`,
    );
    for (const [src, out] of sourceToOutputCss) {
      console.log(`  ${relative(srcDir, src)} -> ${relative(outDir, out)}`);
    }
  }
  if (sourceToOutputAsset.size > 0) {
    console.log(
      `\n📦 Source -> Output mapping (${sourceToOutputAsset.size} Assets):`,
    );
    for (const [src, out] of sourceToOutputAsset) {
      console.log(`  ${relative(srcDir, src)} -> ${relative(outDir, out)}`);
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
        const ref = m[1];
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
          }: url("${ref}") → not found in src/ or static/`,
        );
      }
    }

    if (warnings.length > 0) {
      console.warn(
        `\n⚠️  Warning: ${warnings.length} asset reference(s) in src/ not found in static/:`,
      );
      for (const w of warnings) console.warn(w);
    }
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
