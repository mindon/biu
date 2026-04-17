// biu — watch mode & dev server

import { existsSync, watch } from "node:fs";
import { extname, join, relative } from "node:path";
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
    if (/node_modules|^dist(\/|$)/i.test(filename)) return true;
    if (excludedRules?.test(filename)) return true;
    console.log(
      filename,
      /node_modules|^dist(\/|$)/i.test(filename),
      excludedRules?.test(filename),
    );
    return false;
  };

  // 防抖：避免短时间内多次触发重建
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let building = false;
  const rebuild = (filename?: string, staticMode?: string) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (building) return;
      building = true;
      try {
        console.log(
          filename
            ? `\n✨ Detected change in ${filename}, rebuilding...`
            : "\n✨ Rebuilding...",
        );
        await fullBuild(staticMode);
      } catch (err) {
        console.error("❌ Build error:", err);
      } finally {
        building = false;
      }
    }, 200);
  };

  // 监听源目录
  watch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename || ignored(filename.toString())) return;
    rebuild(filename.toString());
  });

  // 同时监听 static 目录
  if (staticDir && existsSync(staticDir)) {
    watch(staticDir, { recursive: true }, (_event, filename) => {
      rebuild(filename ? filename.toString() : undefined, "static");
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
      if (pathname === "/") pathname = "/index.html";

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
