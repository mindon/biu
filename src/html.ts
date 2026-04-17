// biu — HTML processing & minification

import { minify as minifyHtml } from "html-minifier-terser";
import { readFile } from "node:fs/promises";
import { cleanCss } from "./styles.ts";

/** 处理 HTML：压缩内联 style + 全局 minify */
export async function processHtml(filePath: string): Promise<string> {
  let content = await readFile(filePath, "utf8");

  // Minify <style> content
  content = content.replace(/<style>([\s\S]*?)<\/style>/g, (_match, p1) => {
    return `<style>${cleanCss.minify(p1).styles}</style>`;
  });

  return await minifyHtml(content, {
    collapseWhitespace: true,
    removeComments: true,
    minifyJS: true,
    minifyCSS: true,
  });
}
