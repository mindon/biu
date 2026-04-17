// biu — static asset processing

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { contentHash } from "./utils.ts";

/**
 * 复制静态资源文件到 outDir，加上内容 hash
 * 返回 源绝对路径 → 输出绝对路径 的映射
 */
export async function processAssetFiles(
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

/** 将 staticDir 下的所有内容复制到 outDir */
export async function copyStaticDir(
  staticDir: string,
  outDir: string,
  cwd: string,
) {
  if (!existsSync(staticDir)) return;
  await mkdir(outDir, { recursive: true });
  await cp(staticDir, outDir, { recursive: true, force: true });
  console.log(
    `📁 Static files copied: ${relative(cwd, staticDir)} -> ${
      relative(cwd, outDir)
    }`,
  );
}
