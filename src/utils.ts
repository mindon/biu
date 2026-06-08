// biu — utility functions

import { join } from "node:path";
import { statSync } from "node:fs";

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

/**
 * 删除 JS/TS 源码中的行注释（`//...`）与块注释（`/* ... *\/`），
 * 但完整保留字符串字面量（单/双引号、模板字符串）的内容。
 *
 * 用途：在做基于 regex 的引用扫描（imports / asset-refs / 部署根引用）前
 * 预处理，避免把注释里的代码（如 `// import "/foo.js";`）误识别为真实引用，
 * 导致虚假的 "missing" 警告或多余的依赖图节点。
 *
 * 注意：
 * - 保留换行，行号不变。
 * - 字符串内的 `//` / `/*` 不视为注释。
 * - 不处理 JS 正则字面量（`/foo\/bar/g` 中的 `/...//` 极少与扫描目标冲突，
 *   不在本助手处理范围内；如需更严谨可改用 AST 解析）。
 */
export function stripJsComments(code: string): string {
  const out: string[] = [];
  const len = code.length;
  let i = 0;
  // 0=normal 1=lineComment 2=blockComment 3=string 4=template
  let mode: 0 | 1 | 2 | 3 | 4 = 0;
  let quote = "";
  while (i < len) {
    const c = code[i];
    const n = i + 1 < len ? code[i + 1] : "";
    if (mode === 0) {
      if (c === "/" && n === "/") {
        mode = 1;
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        mode = 2;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        mode = 3;
        quote = c;
        out.push(c);
        i++;
        continue;
      }
      if (c === "`") {
        mode = 4;
        out.push(c);
        i++;
        continue;
      }
      out.push(c);
      i++;
      continue;
    }
    if (mode === 1) {
      // 行注释：保留换行以维持行号
      if (c === "\n") {
        mode = 0;
        out.push("\n");
      }
      i++;
      continue;
    }
    if (mode === 2) {
      if (c === "*" && n === "/") {
        mode = 0;
        i += 2;
        continue;
      }
      if (c === "\n") out.push("\n");
      i++;
      continue;
    }
    if (mode === 3) {
      // 普通字符串 — 处理转义，遇到对应引号闭合
      if (c === "\\" && n) {
        out.push(c, n);
        i += 2;
        continue;
      }
      if (c === quote) {
        mode = 0;
        out.push(c);
        i++;
        continue;
      }
      out.push(c);
      i++;
      continue;
    }
    // mode === 4：模板字符串
    if (c === "\\" && n) {
      out.push(c, n);
      i += 2;
      continue;
    }
    if (c === "`") {
      mode = 0;
      out.push(c);
      i++;
      continue;
    }
    // ${...} 内的内容按原样保留（嵌套字符串/模板的极端情况此处不细分，
    // 对扫描目的不会产生新的误报）
    out.push(c);
    i++;
  }
  return out.join("");
}

// 真实变更去重：fs.watch 在 macOS 上会对某些文件周期性发出虚假
// rename 事件（已观测到 ~213ms 一次）。这里基于 (size, mtimeMs) 指纹
// 过滤掉指纹未变化的事件。
const fingerprints = new Map<string, string>();
export function isRealChange(absPath: string): boolean {
  let fp = "missing";
  try {
    const st = statSync(absPath);
    fp = `${st.size}:${st.mtimeMs}`;
  } catch {
    // 文件被删除：missing 也是一种状态变化
  }
  const prev = fingerprints.get(absPath);
  if (prev === fp) return false;
  fingerprints.set(absPath, fp);
  return true;
}
