// biu, a bundler for htmls with typescript, run with bun
// bun build ./biu.ts --compile --minify --target=browser --outfile=biu
// usage: biu [src-dir] [out-dir] [--watch]
// use ?? to force import ts/js inline, e.g. import {my} from "my.ts??";

import { build, type Plugin } from "bun";
import { minify as minifyHtml } from "html-minifier-terser";
import CleanCSS from "clean-css";
import * as sass from "sass";
import { createHash } from "node:crypto";

// updated from https://github.com/lit/lit/tree/main/packages/labs/rollup-plugin-minify-html-literals/src/lib
import { minifyHTMLLiterals } from "./lib/minify-html-literals.ts";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

import { basename, dirname, extname, join, relative, resolve } from "node:path";

const cleanCss = new CleanCSS();

/** 生成内容 hash（取前8位），用于输出文件名 */
function contentHash(content: string | Buffer, len = 8): string {
  return createHash("md5").update(content).digest("hex").slice(0, len);
}

/** 已由其他步骤处理的文件扩展名（JS/TS/HTML/CSS/SCSS 等） */
const MANAGED_EXTS = new Set([
  ".ts",
  ".js",
  ".mts",
  ".mjs",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
]);

/** 常见的 HTML 静态资源扩展名 */
const ASSET_EXTS = new Set([
  // 图片
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  // 字体
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // 音视频
  ".mp3",
  ".ogg",
  ".wav",
  ".mp4",
  ".webm",
  ".ogv",
  // 其他
  ".json",
  ".xml",
  ".csv",
  ".tsv",
  ".txt",
  ".pdf",
  ".wasm",
  ".map",
]);

// 通过环境变量 BIU_ASSET_EXTS 增加更多静态资源扩展名
// 格式：逗号或空格分隔，扩展名可带或不带点号前缀
// 例如：BIU_ASSET_EXTS="glb,gltf,hdr"
if (process.env.BIU_ASSETS_EXTS) {
  for (
    const raw of process.env.BIU_ASSET_EXTS?.split(/[\s,;]+/).filter(Boolean)
  ) {
    const ext = raw.startsWith(".")
      ? raw.toLowerCase()
      : `.${raw.toLowerCase()}`;
    ASSET_EXTS.add(ext);
  }
}

/**
 * 复制静态资源文件到 outDir，加上内容 hash
 * 返回 源绝对路径 → 输出绝对路径 的映射
 */
async function processAssetFiles(
  assetFiles: string[],
  srcDir: string,
  outDir: string,
): Promise<Map<string, string>> {
  const sourceToOutputAsset = new Map<string, string>();
  const results = await Promise.all(
    assetFiles.map(async (file) => {
      const buf = await readFile(file);
      const hash = contentHash(buf);
      const ext = extname(file);
      const name = basename(file, ext);
      const outputName = name == "favicon" && ext == ".ico"
        ? `${name}${ext}`
        : `${name}-${hash}${ext}`;
      const relDir = dirname(relative(srcDir, file));
      const outputDir = join(outDir, relDir);
      await mkdir(outputDir, { recursive: true });
      const outputPath = join(outputDir, outputName);
      if (!existsSync(outputPath)) {
        await writeFile(outputPath, buf);
      }
      return [file, outputPath] as const;
    }),
  );
  for (const [src, out] of results) {
    sourceToOutputAsset.set(src, out);
  }
  return sourceToOutputAsset;
}

/**
 * 编译 SCSS / 压缩 CSS，返回压缩后的 CSS 文本
 */
async function compileStyle(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  let css: string;
  if (ext === ".scss" || ext === ".sass") {
    const result = sass.compile(filePath);
    css = result.css;
  } else {
    css = await readFile(filePath, "utf8");
  }
  return cleanCss.minify(css).styles;
}

/**
 * 处理所有 scss / css 文件：编译 → 压缩 → 带 hash 输出
 * 返回 sourceToOutputCss 映射 (源绝对路径 → 输出绝对路径)
 */
async function processStyleFiles(
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

/**
 * 基础插件：仅做 html/css 模板字面量压缩，用于构建独立 module 文件
 */
const basePlugin: Plugin = {
  name: "base-plugin",
  setup(builder) {
    builder.onLoad({ filter: /\.(ts|js)$/ }, async (args) => {
      let code = await readFile(args.path, "utf8");
      // 去掉代码中的 ?# 后缀，让 Bun 能正确解析路径
      code = code.replace(
        /((?:import|from)\s+["'][^"']*?)[#\?][^"']*(["'])/g,
        "$1$2",
      );
      const result: any = await minifyHTMLLiterals(code);
      return { contents: result ? result.code : code, loader: "ts" };
    });
  },
};

/**
 * 主入口插件：在 onResolve 阶段拦截非 ?? 导入并标记为 external
 * 关键：Bun 的 onResolve 在 onLoad 之前执行，
 * 所以我们在源码被 onLoad 处理之前就已经把 ?? 路径拦截了
 */
function createMainPlugin(moduleAbsPaths: Set<string>): Plugin {
  return {
    name: "main-plugin",
    setup(builder) {
      // 优先级高：先拦截所有 .ts/.js 导入，检查是否属于 module
      builder.onResolve({ filter: /\.(ts|js)([#\?].*)?$/ }, (args) => {
        if (!args.path.startsWith(".") && !args.path.startsWith("/")) {
          return undefined;
        }
        const cleanPath = args.path.replace(/[#\?].*$/, "");
        const absPath = resolve(dirname(args.importer), cleanPath);

        // 去掉查询参数来解析实际路径
        if (moduleAbsPaths.has(absPath)) {
          // 计算相对路径，将 .ts 改为 .js
          const extra = (args.path.match(/[#\?].*$/) || [""])[0];
          const rel = relative(dirname(args.importer), absPath).replace(
            /\.ts$/,
            `.js${extra}`,
          );
          const relPath = rel.startsWith(".") ? rel : `./${rel}`;
          return { path: relPath, external: !/\?\?/.test(args.path) };
        }
        return undefined;
      });

      // onLoad：压缩模板字面量 + 去掉 ?# 后缀
      builder.onLoad({ filter: /\.(ts|js)$/ }, async (args) => {
        let code = await readFile(args.path, "utf8");
        code = code.replace(
          /(\b(?:import|from)\s+["'][^"']*?)[#?][^"']*(["'])/g,
          "$1$2",
        );
        const result: any = await minifyHTMLLiterals(code);
        return { contents: result ? result.code : code, loader: "ts" };
      });
    },
  };
}

async function processHtml(filePath: string) {
  let content = await readFile(filePath, "utf8");

  // Minify <style> content
  content = content.replace(/<style>([\s\S]*?)<\/style>/g, (match, p1) => {
    return `<style>${cleanCss.minify(p1).styles}</style>`;
  });

  return await minifyHtml(content, {
    collapseWhitespace: true,
    removeComments: true,
    minifyJS: true,
    minifyCSS: true,
  });
}

async function buildProject(srcDir: string, outDir: string) {
  // Simple recursive scan
  async function scan(dir: string): Promise<string[]> {
    const files = await readdir(dir, { withFileTypes: true });
    let paths: string[] = [];
    for (const file of files) {
      const path = join(dir, file.name);
      if (file.isDirectory()) {
        paths = [...paths, ...(await scan(path))];
      } else {
        paths.push(path);
      }
    }
    return paths;
  }

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

  // 递归解析依赖
  async function resolveDependencies(
    initial: string[],
    initialModules: string[],
  ): Promise<{ entrypoints: string[]; moduleEntries: string[]; extras: {} }> {
    const deps = new Set<string>(initial);
    const modules = new Set<string>(initialModules);
    const queue = [...initial, ...initialModules];
    const extras = {};

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
            deps.add(depPath);
          } else {
            modules.add(depPath);
            if (match[3]) extras[depPath] = match[3];
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

  // 从 HTML 入口开始分析依赖（并行读取所有 HTML）
  let initialEntries: string[] = [];
  const initialModules: string[] = [];

  const htmlContents = await Promise.all(
    htmlFiles.map(async (htmlFile) => ({
      file: htmlFile,
      content: await readFile(htmlFile, "utf8"),
    })),
  );
  for (const { file: htmlFile, content: htmlContent } of htmlContents) {
    const matches = htmlContent.matchAll(
      /(?:src|import|from)\s*[:=]\s*["'](\.?\/?.*?\.(ts|js)([#\?][^"']*)?)["']/g,
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
  );
  // console.log("Module entries:", moduleEntries);

  // 构建 JS/TS
  // 建立源文件绝对路径 -> 构建产物路径的映射
  const sourceToOutput = new Map<string, string>();
  const allOutputs: any[] = [];

  // 确保 entrypoints 中不再包含已是独立的 modules
  const cleanEntrypoints = entrypoints.filter((e) =>
    !moduleEntries.includes(e)
  );
  const moduleAbsPaths = new Set(moduleEntries);

  // 1. 先构建 moduleEntries（使用 basePlugin，因为 module 自身也可能依赖其他 module）
  // module 之间也可能有依赖，所以 module 构建也需要 external 拦截
  // 注意：module 之间有依赖顺序，需要串行构建
  async function buildModules() {
    for (const file of moduleEntries) {
      // 这个 module 可能依赖其他 module，需要将"其他 module"标记为 external
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
  async function updateCssUrls() {
    // 更新 CSS 产物中的 url() 引用，指向带 hash 的资源文件
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

  async function updateJsImports() {
    // 构建产物路径 → 源文件路径的反向映射，用于确定 JS 产物的源目录
    const outputToSource = new Map<string, string>();
    for (const [src, out] of sourceToOutput) {
      outputToSource.set(out, src);
    }

    // 更新 JS 产物内部的 import 路径 + 资源路径字符串
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
          // 例如: "./img/logo.png" → "./img/logo-abc12345.png"
          //       "./styles.scss" → "./styles-hash.css"
          //       new Worker("./worker.ts") → new Worker("./worker-hash.js")
          const jsSrcFile = outputToSource.get(output.path);
          if (jsSrcFile) {
            const jsSrcDir = dirname(jsSrcFile);
            const jsOutDir = dirname(output.path);

            // 合并所有需要替换的映射：Asset + CSS + JS/TS（不含自身和已由 import 处理的）
            // 按源文件相对路径长度降序排列，确保长路径优先匹配
            const allMappings: [string, string][] = [];
            for (const [src, out] of sourceToOutputAsset) {
              allMappings.push([src, out]);
            }
            for (const [src, out] of sourceToOutputCss) {
              allMappings.push([src, out]);
            }
            for (const [src, out] of sourceToOutput) {
              // 跳过自身；import/from 引用由 (a) 处理，这里处理非 import 的字符串引用
              if (src === jsSrcFile) continue;
              allMappings.push([src, out]);
            }

            // 按相对路径长度降序排列，长路径优先匹配，防止短路径子串误匹配
            allMappings.sort((a, b) =>
              relative(jsSrcDir, b[0]).length - relative(jsSrcDir, a[0]).length
            );

            for (const [mappedSrcFile, mappedOutFile] of allMappings) {
              // 计算从 JS 源文件到引用文件的相对路径
              const relFromJs = relative(jsSrcDir, mappedSrcFile);
              const escapedRelPath = relFromJs.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
              );
              // 匹配字符串字面量中的路径：
              // "img/logo.png" / "./styles.scss" / './worker.ts' 等
              // 排除 data: URI 和 import/from 语句
              const newCode = code.replace(
                new RegExp(
                  `(["'\`])(?:\\.\\/)?${escapedRelPath}(["'\`])`,
                  "g",
                ),
                (match, q1, q2, offset) => {
                  // 排除 data: URI
                  if (
                    offset > 5 &&
                    /data\s*:[^"'`]*$/i.test(
                      code.slice(Math.max(0, offset - 200), offset),
                    )
                  ) {
                    return match;
                  }
                  // 排除 import/from 语句（这些由 (a) 处理）
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

  await Promise.all([updateCssUrls(), updateJsImports()]);

  // ── 并行阶段 3：多个 HTML 文件并行处理引用替换 ──
  console.log("\nHTML Files Processing:");
  await Promise.all(
    htmlFiles.map(async (file) => {
      let content = await processHtml(file);
      console.log(" ", relative(srcDir, file));

      // 4a. 替换 JS 引用（使用完整相对路径匹配，支持子目录）
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

      // 4b. 替换 CSS/SCSS 引用（使用完整相对路径匹配，支持子目录）
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

      // 4c. 替换静态资源引用（图片/字体/音视频等）
      for (const [srcFile, outputFile] of sourceToOutputAsset) {
        const targetDir = dirname(file.replace(srcDir, outDir));
        const htmlSrcDir = dirname(file);
        const relFromHtml = relative(htmlSrcDir, srcFile);
        const escapedRelPath = relFromHtml.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        // 排除 data: URI（base64 内联资源）
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

async function run() {
  const isWatch = process.argv.includes("--watch");
  let i = 2;
  if (process.argv[2] == "--watch") {
    i = 3;
  }

  const srcDir = resolve(process.argv[i] || "./src");
  const outDir = resolve(process.argv[i + 1] || "./dist");

  if (isWatch) {
    console.log("🚀 Watch mode enabled...");
    // 首次构建
    await buildProject(srcDir, outDir);

    // 监听源目录
    const watcher = Bun.watch(
      resolve(process.argv[2] || "./"),
      async (event, filename) => {
        if (filename && !/node_modules|dist/.test(filename)) {
          console.log(`✨ Detected change in ${filename}, rebuilding...`);
          await buildProject(srcDir, outDir);
        }
      },
    );
  } else {
    await buildProject(srcDir, outDir);
  }
}
console.log("\nbiu v2026.0414\nusage: biu [src-dir] [out-dir] [--watch]\n\n");
run().catch(console.error);
