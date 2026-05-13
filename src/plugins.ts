// biu — Bun build plugins

import type { Plugin } from "bun";
import { dirname, relative, resolve } from "node:path";
import { minifyHTMLLiterals } from "../plugins/minify-html-literals/minify-html-literals.ts";

// 快速检测代码中是否存在 html` 或 css` 模板字面量标签
const hasTemplateLiterals = (code: string) => /\b(?:html|css)`/s.test(code);

/**
 * 基础插件：仅做 html/css 模板字面量压缩，用于构建独立 module 文件
 */
export const basePlugin: Plugin = {
  name: "base-plugin",
  setup(builder) {
    builder.onLoad({ filter: /\.(ts|js)$/ }, async (args) => {
      let code = await Bun.file(args.path).text();
      // 去掉代码中的 ?# 后缀，让 Bun 能正确解析路径
      code = code.replace(
        /((?:import|from)\s+["'][^"']*?)[#\?][^"']*(["'])/g,
        "$1$2",
      );
      if (hasTemplateLiterals(code)) {
        const result: any = await minifyHTMLLiterals(code);
        if (result) code = result.code;
      }
      return { contents: code, loader: "ts" };
    });
  },
};

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
): Plugin {
  return {
    name: "main-plugin",
    setup(builder) {
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
          const result: any = await minifyHTMLLiterals(code);
          if (result) code = result.code;
        }
        // 仅给当前 entry 注入上游 hash 种子，让 bun 计算 entry 产物文件名时
        // 把上游 hash 纳入指纹（external 默认不计入 hash）。
        // 用 export const 而不是注释/字符串字面量：注释会被 minify 移除、
        // 表达式语句会被 DCE，而 entry 的 export 一定保留在产物中，从而进入
        // bun 的内容指纹计算 → 上游变 → entry 文件名 hash 变。
        if (entryHashSeed && entry && args.path === entry) {
          code = `export const __biu_upstream__=${
            JSON.stringify(entryHashSeed)
          };\n${code}`;
        }
        return { contents: code, loader: "ts" };
      });
    },
  };
}
