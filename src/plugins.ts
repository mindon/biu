// biu — Bun build plugins

import type { Plugin } from "bun";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { minifyHTMLLiterals } from "../plugins/minify-html-literals/minify-html-literals.ts";

/**
 * 基础插件：仅做 html/css 模板字面量压缩，用于构建独立 module 文件
 */
export const basePlugin: Plugin = {
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
export function createMainPlugin(moduleAbsPaths: Set<string>): Plugin {
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
