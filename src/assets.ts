// biu — static asset processing

import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
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
  forceWrite = false,
): Promise<{ map: Map<string, string>; wrote: number }> {
  const sourceToOutputAsset = new Map<string, string>();
  let wrote = 0;
  const results = await Promise.all(
    assetFiles.map(async (file) => {
      const buf = Buffer.from(await Bun.file(file).arrayBuffer());
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
      let written = false;
      if (forceWrite || !existsSync(outputPath)) {
        await Bun.write(outputPath, buf);
        written = true;
      }
      return [file, outputPath, written] as const;
    }),
  );
  for (const [src, out, written] of results) {
    sourceToOutputAsset.set(src, out);
    if (written) wrote++;
  }
  return { map: sourceToOutputAsset, wrote };
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
