// biu — Bun build plugins

import type { Plugin } from "bun";
import { realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { minifyHTMLLiterals } from "../plugins/minify-html-literals/minify-html-literals.ts";
import { type ImportMapSpecifiers, isImportMapMapped } from "./importmaps.ts";

// 快速检测代码中是否存在 html` 或 css` 模板字面量标签
const hasTemplateLiterals = (code: string) => /\b(?:html|css)`/s.test(code);

function isBareSpecifier(spec: string): boolean {
  return !spec.startsWith(".") && !spec.startsWith("/") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(spec);
}

/**
 * 把以 `/` 开头的 specifier（如 `import "/simple.js"`）标记为 external。
 *
 * 语义：在 biu 项目里 `/xxx` 是\"部署根路径\"——指向 `static/xxx`，运行时由
 *      浏览器/web 服务器按 web root 解析（同 `<img src=\"/foo.png\">`）。
 *      构建期不应尝试把它当文件系统绝对路径解析（否则 bun 会报
 *      `Could not resolve: \"/simple.js\"`）。
 *
 * 注意：必须放在所有 `.ts` / `.js` 后缀过滤器之前注册，否则 bun 默认解析
 *      会先把 `/foo.js` 当文件系统路径解析失败而直接抛错。
 */
function setupRootAbsoluteExternals(
  builder: Parameters<Plugin["setup"]>[0],
): void {
  builder.onResolve({ filter: /^\// }, (args) => {
    // 关键：entrypoint 传入的是文件系统绝对路径（如 /Users/.../main.ts），
    // 此时 importer 为空——必须放过让 bun 走默认解析；否则所有 entry 都
    // 会被 external 化，构建出 0 个 JS。
    if (!args.importer) return undefined;
    // 真正的 import 语句中的 / 起头 specifier → web root，标记 external，
    // 由浏览器在运行时按部署根（即 static/ 复制到 outDir 后的位置）解析。
    return { path: args.path, external: true };
  });
}

function setupImportMapExternals(
  builder: Parameters<Plugin["setup"]>[0],
  importMapSpecifiers?: ImportMapSpecifiers,
): void {
  if (!importMapSpecifiers || importMapSpecifiers.size === 0) return;
  builder.onResolve({ filter: /.*/ }, (args) => {
    if (
      isBareSpecifier(args.path) &&
      isImportMapMapped(args.path, importMapSpecifiers)
    ) {
      // 由 import map 在浏览器运行时解析，Bun 不应解析、安装或 bundle。
      return { path: args.path, external: true };
    }
    return undefined;
  });
}

/**
 * 把路径归一化为 realpath（解析 symlink），失败时回退原路径。
 * 用于跨"输入路径 vs onLoad 传入路径"的稳健比较：例如在 macOS 下
 * `/tmp` 是 `/private/tmp` 的 symlink，bun 在 onLoad 中传入的路径已被
 * realpath 解析，但调用方传入的 entry 可能是原始路径。
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 基础插件：仅做 html/css 模板字面量压缩，用于构建独立 module 文件
 */
export function createBasePlugin(
  importMapSpecifiers?: ImportMapSpecifiers,
): Plugin {
  return {
    name: "base-plugin",
    setup(builder) {
      setupRootAbsoluteExternals(builder);
      setupImportMapExternals(builder, importMapSpecifiers);
      builder.onLoad({ filter: /\.(ts|js)$/ }, async (args) => {
        let code = await Bun.file(args.path).text();
        // 去掉代码中的 ?# 后缀，让 Bun 能正确解析路径
        code = code.replace(
          /((?:import|from)\s+["'][^"']*?)[#\?][^"']*(["'])/g,
          "$1$2",
        );
        if (hasTemplateLiterals(code)) {
          try {
            const result: any = await minifyHTMLLiterals(code);
            if (result) code = result.code;
          } catch (e) {
            // 模板压缩失败时降级：保留原码继续构建，只发警告。
            // 之前的实现会让单个文件的模板异常（如复杂嵌套的 lit-html）
            // 把整个 build 拖垮。
            console.warn(
              `⚠️  minify-html-literals failed in ${args.path}: ${
                (e as Error).message
              } — keeping original code.`,
            );
          }
        }
        return { contents: code, loader: "ts" };
      });
    },
  };
}

export const basePlugin: Plugin = createBasePlugin();

/**
 * 主入口插件：在 onResolve 阶段拦截非 ?? 导入并标记为 external
 * 关键：Bun 的 onResolve 在 onLoad 之前执行，
 * 所以我们在源码被 onLoad 处理之前就已经把 ?? 路径拦截了
 *
 * @param moduleAbsPaths 所有 module entry 的源文件绝对路径集合
 * @param moduleOutputs  已构建完成的 module 源文件 → 产物绝对路径映射。
 *                       当 importer 引用了已构建的 module 时，external 路径会
 *                       使用真实的产物文件名（含 hash），从而让 importer 自身
 *                       的内容指纹反映上游变化，触发真正的重新构建。
 * @param entry          当前正在构建的 entry 源文件绝对路径。
 * @param entryHashSeed  仅注入到 entry 自身源码顶部的注释字符串（不影响其他
 *                       被 bundle 的文件）。用于将上游产物 hash 作为内容指纹
 *                       种子注入，使 bun 给 entry 计算出的产物文件名能反映
 *                       上游变化（external 默认不计入 hash）。
 */
export function createMainPlugin(
  moduleAbsPaths: Set<string>,
  moduleOutputs?: Map<string, string>,
  entry?: string,
  entryHashSeed?: string,
  importMapSpecifiers?: ImportMapSpecifiers,
): Plugin {
  return {
    name: "main-plugin",
    setup(builder) {
      setupRootAbsoluteExternals(builder);
      setupImportMapExternals(builder, importMapSpecifiers);
      // 预先把 entry 归一化为 realpath，避免 macOS 下 `/tmp` ↔ `/private/tmp`
      // 这类 symlink 导致 args.path 与 entry 字符串不等 → seed 注入失败。
      const entryReal = entry ? safeRealpath(entry) : undefined;

      // 优先级高：先拦截 .ts 导入，检查是否属于 module
      // 注意：不能匹配 .js，否则会干扰 node_modules 中 .js 模块的解析（Bun bug）
      builder.onResolve({ filter: /\.ts([#\?].*)?$/ }, (args) => {
        if (!args.path.startsWith(".") && !args.path.startsWith("/")) {
          return undefined;
        }
        const cleanPath = args.path.replace(/[#\?].*$/, "");
        const absPath = resolve(dirname(args.importer), cleanPath);

        // 去掉查询参数来解析实际路径
        if (moduleAbsPaths.has(absPath)) {
          const isForceInline = /\?\?/.test(args.path);
          if (isForceInline) {
            // ?? → 不标记为 external，直接返回绝对路径让 bun bundle 它
            return { path: absPath, external: false };
          }
          // 非 ?? → 标记为 external，用相对路径指向产物
          const extra = (args.path.match(/[#\?].*$/) || [""])[0];
          // 优先使用已构建产物的真实文件名（含 hash），让 importer 的内容
          // 指纹随上游变化而变化；否则回退到无 hash 的占位（首轮拓扑构建时）
          const outputAbs = moduleOutputs?.get(absPath);
          let rel: string;
          if (outputAbs) {
            rel = relative(dirname(args.importer), outputAbs);
            if (extra) rel += extra;
          } else {
            rel = relative(dirname(args.importer), absPath).replace(
              /\.ts$/,
              `.js${extra}`,
            );
          }
          const relPath = rel.startsWith(".") ? rel : `./${rel}`;
          return { path: relPath, external: true };
        }
        return undefined;
      });

      // onLoad：压缩模板字面量 + 去掉 ?# 后缀（但保留 ?? 标记供 onResolve 识别）
      builder.onLoad({ filter: /\.(ts|js)$/ }, async (args) => {
        let code = await Bun.file(args.path).text();
        // 先保护 ?? 标记，替换为占位符
        code = code.replace(
          /(\b(?:import|from)\s+["'][^"']*?)\?\?([^"']*["'])/g,
          "$1\x00FORCEINLINE\x00$2",
        );
        // 去掉普通的 ?# 后缀
        code = code.replace(
          /(\b(?:import|from)\s+["'][^"']*?)[#?][^"']*(["'])/g,
          "$1$2",
        );
        // 恢复 ?? 标记
        code = code.replace(/\x00FORCEINLINE\x00/g, "??");
        if (hasTemplateLiterals(code)) {
          try {
            const result: any = await minifyHTMLLiterals(code);
            if (result) code = result.code;
          } catch (e) {
            // 模板压缩失败时降级：保留原码继续构建，只发警告。
            console.warn(
              `⚠️  minify-html-literals failed in ${args.path}: ${
                (e as Error).message
              } — keeping original code.`,
            );
          }
        }
        // 仅给当前 entry 注入上游 hash 种子，让 bun 计算 entry 产物文件名时
        // 把上游 hash 纳入指纹（external 默认不计入 hash）。
        //
        // ⚠️ 不能用 `export const` / `globalThis.X = ...`：bun minify 会把
        // 未读取的导出和无副作用的赋值都 DCE 掉，种子从而无法进入产物 hash 计算。
        //
        // 用 `/*! ... */` license-style 注释：bun minify 默认保留这类注释
        // （其它注释会被剥离），它能稳定地保留在产物中、参与 contenthash 计算，
        // 且没有任何运行时开销。
        if (entryHashSeed && entryReal && args.path === entryReal) {
          // 防御：seed 实际只含 [a-z0-9.,:|/_-]，但保险起见把 */ 转义掉
          // （否则会提前关闭注释，破坏 JS 语法）
          const safeSeed = entryHashSeed.replace(/\*\//g, "*\\/");
          code = `/*! __biu_upstream__:${safeSeed} */\n${code}`;
        }
        return { contents: code, loader: "ts" };
      });
    },
  };
}
