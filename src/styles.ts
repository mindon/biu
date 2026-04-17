// biu — CSS/SCSS compilation & processing

import CleanCSS from "clean-css";
import * as sass from "sass";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { contentHash } from "./utils.ts";

export const cleanCss = new CleanCSS();

/**
 * 编译 SCSS / 压缩 CSS，返回压缩后的 CSS 文本
 */
export async function compileStyle(filePath: string): Promise<string> {
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
export async function processStyleFiles(
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
