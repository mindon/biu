// biu — core build logic

import { build } from "bun";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { ASSET_EXTS, MANAGED_EXTS } from "./constants.ts";
import { scan } from "./utils.ts";
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
    const code = await readFile(file, "utf8");
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
        if (/\?\?/.test(fullPath)) {
          // ?? suffix → force inline
          deps.add(depPath);
        } else if (htmlRawContents.includes(basename(depPath))) {
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
      let css = await readFile(cssOutFile, "utf8");
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
        await writeFile(cssOutFile, css);
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
        let code = await readFile(output.path, "utf8");
        let changed = false;

        // (a) 替换 import/from 中的 module 引用路径
        for (const [srcFile, outputFile] of sourceToOutput) {
          if (!moduleAbsPaths.has(srcFile)) continue;

          const srcBaseName = basename(srcFile).replace(/\.(ts|js)$/, "");
          const outputFileName = basename(outputFile);

          const patterns = [
            new RegExp(
              `((?:import|from)\\s*["']\\.\\/)(${srcBaseName})(\\.(?:js|ts))(["'])`,
              "g",
            ),
            new RegExp(
              `((?:import|from)\\s*["'][^"']*\\/)(${srcBaseName})(\\.(?:js|ts))(["'])`,
              "g",
            ),
          ];

          for (const pattern of patterns) {
            const newCode = code.replace(
              pattern,
              `$1${outputFileName}${extras?.[srcFile] ?? ""}$4`,
            );
            if (newCode !== code) {
              code = newCode;
              changed = true;
            }
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
          await writeFile(output.path, code);
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
) {
  console.log("\nHTML Files Processing:");
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
      await writeFile(targetPath, content);
    }),
  );
}

/**
 * 主构建流程
 */
export async function buildProject(srcDir: string, outDir: string) {
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

  // 从 HTML 入口开始分析依赖
  let initialEntries: string[] = [];
  const initialModules: string[] = [];

  const htmlContents = await Promise.all(
    htmlFiles.map(async (htmlFile) => ({
      file: htmlFile,
      content: await readFile(htmlFile, "utf8"),
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
  async function buildModules() {
    for (const file of moduleEntries) {
      const otherModules = new Set(moduleEntries.filter((m) => m !== file));
      const plugin = otherModules.size > 0
        ? createMainPlugin(otherModules)
        : basePlugin;

      const res = await build({
        entrypoints: [file],
        outdir: join(outDir, dirname(file.replace(srcDir, ""))),
        minify: true,
        target: "browser",
        naming: "[name]-[hash].js",
        plugins: [plugin],
      });
      for (const output of res.outputs) {
        allOutputs.push(output);
        sourceToOutput.set(file, output.path);
      }
    }
  }

  // ── 并行阶段 1：JS build / CSS 编译 / Asset 复制 三路并行 ──
  const [, sourceToOutputCss, sourceToOutputAsset] = await Promise.all([
    buildModules(),
    processStyleFiles(styleFiles, srcDir, outDir),
    processAssetFiles(assetFiles, srcDir, outDir),
  ]);

  console.log("Source -> Output mapping (JS):");
  for (const [src, out] of sourceToOutput) {
    console.log(`  ${relative(srcDir, src)} -> ${relative(outDir, out)}`);
  }
  if (sourceToOutputCss.size > 0) {
    console.log("\nSource -> Output mapping (CSS):");
    for (const [src, out] of sourceToOutputCss) {
      console.log(`  ${relative(srcDir, src)} -> ${relative(outDir, out)}`);
    }
  }
  if (sourceToOutputAsset.size > 0) {
    console.log("\nSource -> Output mapping (Assets):");
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
  await processHtmlFiles(
    htmlFiles,
    srcDir,
    outDir,
    sourceToOutput,
    sourceToOutputCss,
    sourceToOutputAsset,
  );
}
