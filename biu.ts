// biu, a bundler for htmls with typescript, run with bun
// bun build ./biu.ts --compile --outfile=biu
// usage: biu [src-dir] [out-dir] [--watch]
// use ?? to force import ts/js inline, e.g. import {my} from "my.ts??";

import { build, type Plugin } from "bun";
import { minify as minifyHtml } from "html-minifier-terser";
import CleanCSS from "clean-css";

// updated from https://github.com/lit/lit/tree/main/packages/labs/rollup-plugin-minify-html-literals/src/lib
import { minifyHTMLLiterals } from "./lib/minify-html-literals.ts";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

import { basename, dirname, join, relative, resolve } from "node:path";

const cleanCss = new CleanCSS();

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
      const result = minifyHTMLLiterals(code);
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
        // const result = minifyHTMLLiterals(code);
        return { contents: code, loader: "ts" };
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

  // 从 HTML 入口开始分析依赖
  let initialEntries: string[] = [];
  const initialModules: string[] = [];

  for (const htmlFile of htmlFiles) {
    const htmlContent = await readFile(htmlFile, "utf8");
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

  console.log("Source -> Output mapping:");
  for (const [src, out] of sourceToOutput) {
    console.log(`  ${relative(srcDir, src)} -> ${relative(outDir, out)}`);
  }

  // 3. 构建后处理：更新 JS 产物内部的 import 路径，使其指向带哈希的新文件名
  for (const output of allOutputs) {
    if (!output.path.endsWith(".js")) continue;
    let code = await readFile(output.path, "utf8");
    let changed = false;

    // 遍历所有 module 映射，替换产物中的 import 路径
    for (const [srcFile, outputFile] of sourceToOutput) {
      if (!moduleAbsPaths.has(srcFile)) continue;

      const srcBaseName = basename(srcFile).replace(/\.(ts|js)$/, "");
      const outputFileName = basename(outputFile);

      // 匹配产物中对这个模块的引用：
      // import ... from "./test.js"  或 from"./test.js" (minified)
      const patterns = [
        // 标准格式: "./name.js" 或 "./name.ts"
        new RegExp(
          `((?:import|from)\\s*["']\\.\\/)(${srcBaseName})(\\.(?:js|ts))(["'])`,
          "g",
        ),
        // 可能带路径: from"./sub/name.js"
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

    if (changed) {
      await writeFile(output.path, code);
    }
  }

  // 4. 更新 HTML 中的引用
  console.log("\nHTML Files Processing:");
  for (const file of htmlFiles) {
    let content = await processHtml(file);
    console.log(" ", relative(srcDir, file));

    for (const [srcFile, outputFile] of sourceToOutput) {
      const srcBaseName = basename(srcFile).replace(/\.(ts|js)$/, "");
      const outputFileName = basename(outputFile);

      // 替换 HTML 中的 src="./main.ts" -> src="./main-[hash].js"
      // 以及 inline script 中的 from './test.ts' -> from './test-[hash].js' 或 from '../test.ts'
      // 替换 HTML 中的引用，保留相对路径前缀
      content = content.replace(
        new RegExp(
          `(["'])((?:\\.\\/|\\.\\.\\/)?)[^"']*${srcBaseName}(\\.(?:ts|js))([#\\?][^"']*)?(['"])`,
          "g",
        ),
        `$1$2${outputFileName}$4$5`,
      );
    }

    const targetPath = file.replace(srcDir, outDir);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
  }
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
        if (filename && /\.(ts|js|html)$/.test(filename)) {
          console.log(`✨ Detected change in ${filename}, rebuilding...`);
          await buildProject(srcDir, outDir);
        }
      },
    );
  } else {
    await buildProject(srcDir, outDir);
  }
}
console.log("\nbiu v2026.0413\nusage: biu [src-dir] [out-dir] [--watch]\n\n");
run().catch(console.error);
