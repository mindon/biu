// biu — utility functions

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** 生成内容 hash（取前8位），用于输出文件名 */
export function contentHash(content: string | Buffer, len = 8): string {
  return createHash("md5").update(content).digest("hex").slice(0, len);
}

/** 递归扫描目录下的所有文件 */
export async function scan(dir: string): Promise<string[]> {
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
