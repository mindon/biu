// biu — utility functions

import { join } from "node:path";

/** 生成内容 hash（取前8位），用于输出文件名 */
export function contentHash(
  content: string | Buffer | Uint8Array,
  len = 8,
): string {
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

// ─── 全局 asset 内容 hash 缓存 ──────────────────────────────────────
// 同一次构建中，许多 entry / CSS 会引用相同的图片/字体等 asset；
// 用 Promise 缓存避免重复读盘 + 重复 hash 计算（跨 buildModules / processStyleFiles 共享）。
// 仅在单次构建生命周期内有效；进入新一次构建前请调用 resetAssetHashCache()。
const assetHashCache = new Map<string, Promise<string | null>>();

/**
 * 取（并缓存）单个文件的 16 位内容 hash；读取失败时缓存 null（不再重复尝试）。
 */
export function hashAssetCached(ref: string): Promise<string | null> {
  let p = assetHashCache.get(ref);
  if (!p) {
    p = (async () => {
      try {
        const bytes = await Bun.file(ref).bytes();
        return contentHash(bytes, 16);
      } catch {
        return null;
      }
    })();
    assetHashCache.set(ref, p);
  }
  return p;
}

/** 在每次完整构建开始前清空缓存，避免 watch / dev 模式下读到陈旧 hash */
export function resetAssetHashCache(): void {
  assetHashCache.clear();
}
