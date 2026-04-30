// biu — utility functions

import { join } from "node:path";

/** 生成内容 hash（取前8位），用于输出文件名 */
export function contentHash(content: string | Buffer, len = 8): string {
  return new Bun.CryptoHasher("md5").update(content).digest("hex").slice(
    0,
    len,
  );
}

/** 递归扫描目录下的所有文件 */
export async function scan(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const paths: string[] = [];
  for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
    paths.push(join(dir, rel));
  }
  return paths;
}
