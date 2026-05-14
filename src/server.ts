// biu — watch mode & dev server

import { existsSync, statSync, watch } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { excludedRules } from "./constants.ts";

/**
 * 启动 Watch 模式，监听 srcDir 和 staticDir 的变更并触发重建
 */
export function startWatcher(
  srcDir: string,
  staticDir: string | null,
  cwd: string,
  fullBuild: (staticMode?: string) => Promise<void>,
) {
  console.log("🚀 Watch mode enabled...");

  const ignored = (filename?: string) => {
    if (!filename) return true;
    if (/(?:^|\/)(?:node_modules|dist)(?:\/|$)/i.test(filename)) return true;
    // macOS / 编辑器临时文件、隐藏文件
    const base = basename(filename);
    if (base === ".DS_Store" || base.startsWith("._")) return true;
    if (/(?:\.swp|\.swx|~)$/i.test(base)) return true;
    if (excludedRules?.test(filename)) return true;
    return false;
  };

  // 真实变更去重：fs.watch 在 macOS 上会对某些文件周期性发出虚假
  // rename 事件（已观测到 ~213ms 一次）。这里基于 (size, mtimeMs) 指纹
  // 过滤掉指纹未变化的事件。
  const fingerprints = new Map<string, string>();
  const isRealChange = (absPath: string): boolean => {
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
  };

  // 防抖：避免短时间内多次触发重建
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let building = false;
  let pendingFilename: string | undefined;
  let pendingStaticMode: string | undefined;
  const rebuild = (filename?: string, staticMode?: string) => {
    pendingFilename = filename ?? pendingFilename;
    pendingStaticMode = staticMode ?? pendingStaticMode;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (building) return;
      building = true;
      const fname = pendingFilename;
      const mode = pendingStaticMode;
      pendingFilename = undefined;
      pendingStaticMode = undefined;
      const now = new Date().toLocaleTimeString();
      try {
        console.log(
          fname
            ? `\n✨ Detected change in ${fname}, rebuilding...`
            : "\n✨ Rebuilding...",
        );
        await fullBuild(mode);
        console.log(
          fname
            ? `\n✨ ${fname} changed at ${now}`
            : `\n✨ rebuilded at ${now}`,
        );
      } catch (err) {
        console.error("❌ Build error:", err, now);
      } finally {
        building = false;
      }
    }, 200);
  };

  // 监听源目录
  watch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.toString();
    if (ignored(rel)) return;
    if (!isRealChange(join(srcDir, rel))) return;
    rebuild(rel);
  });

  // 同时监听 static 目录
  if (staticDir && existsSync(staticDir)) {
    watch(staticDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (ignored(rel)) return;
      if (!isRealChange(join(staticDir, rel))) return;
      rebuild(rel, "static");
    });
    console.log(`👀 Watching static dir: ${relative(cwd, staticDir)}`);
  }
}

/**
 * 启动静态文件开发服务器
 */
export function startDevServer(outDir: string, port: number, cwd: string) {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      let pathname = decodeURIComponent(url.pathname);
      // 默认 / → /index.html
      if (pathname.endsWith("/")) pathname = `${pathname}/index.html`;

      const filePath = join(outDir, pathname);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
      // SPA fallback: 如果请求没有扩展名，尝试 index.html
      if (!extname(pathname)) {
        const fallback = Bun.file(join(outDir, "index.html"));
        if (await fallback.exists()) {
          return new Response(fallback);
        }
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  console.log(
    `🌐 Serving ${relative(cwd, outDir)} at http://localhost:${port}`,
  );
}
