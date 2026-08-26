// biu — watch mode & dev server

import { existsSync, lstatSync, watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { excludedRules } from "./constants.ts";
import { isRealChange } from "./utils.ts";

function ignored(filename?: string): boolean {
  if (!filename) return true;
  if (/(?:^|\/)(?:node_modules|dist)(?:\/|$)/i.test(filename)) return true;
  // macOS / 编辑器临时文件、隐藏文件
  const base = basename(filename);
  if (base === ".") return true;
  if (/(?:\.swp|\.swx|~)$/i.test(base)) return true;
  if (excludedRules?.test(filename)) return true;
  return false;
}

export interface RebuildScheduler {
  enqueue(filename?: string, staticMode?: string): void;
  whenIdle(): Promise<void>;
}

/**
 * 将高频文件事件合并为串行构建。构建过程中出现的新事件会在当前构建结束后补跑，
 * 不会因防抖计时器恰好命中 building 状态而丢失。
 */
export function createRebuildScheduler(
  rebuild: (filename?: string, staticMode?: string) => Promise<void>,
  delay = 200,
): RebuildScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let building = false;
  let pending = false;
  let pendingFilename: string | undefined;
  let pendingStaticMode: string | undefined;
  const idleResolvers = new Set<() => void>();

  const resolveIdle = () => {
    if (building || pending || timer) return;
    for (const resolve of idleResolvers) resolve();
    idleResolvers.clear();
  };

  const schedule = () => {
    if (building || timer || !pending) return;
    timer = setTimeout(async () => {
      timer = null;
      if (building || !pending) return;
      const filename = pendingFilename;
      const staticMode = pendingStaticMode;
      pending = false;
      pendingFilename = undefined;
      pendingStaticMode = undefined;
      building = true;
      try {
        await rebuild(filename, staticMode);
      } finally {
        building = false;
        schedule();
        resolveIdle();
      }
    }, delay);
  };

  return {
    enqueue(filename?: string, staticMode?: string) {
      pending = true;
      pendingFilename = filename ?? pendingFilename;
      pendingStaticMode = staticMode ?? pendingStaticMode;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      schedule();
    },
    whenIdle() {
      if (!building && !pending && !timer) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.add(resolve));
    },
  };
}

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

  const rebuild = createRebuildScheduler(async (filename, staticMode) => {
    const now = new Date().toLocaleTimeString();
    try {
      console.log(
        filename
          ? `\n✨ Detected change in ${filename}, rebuilding...`
          : "\n✨ Rebuilding...",
      );
      await fullBuild(staticMode);
      console.log(
        filename
          ? `\n✨ ${filename} changed at ${now}`
          : `\n✨ rebuilded at ${now}`,
      );
    } catch (err) {
      console.error("❌ Build error:", err, now);
    }
  });

  // 监听源目录
  watch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.toString();
    if (ignored(rel)) return;
    if (!isRealChange(join(srcDir, rel))) return;
    rebuild.enqueue(rel);
  });

  // 同时监听 static 目录
  if (staticDir && existsSync(staticDir)) {
    watch(staticDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (ignored(rel)) return;
      if (!isRealChange(join(staticDir, rel))) return;
      rebuild.enqueue(rel, "static");
    });
    console.log(`👀 Watching static dir: ${relative(cwd, staticDir)}`);
  }
}

export interface RouteContext {
  params: Record<string, string>;
  query: Record<string, string>;
  pathname: string;
}

async function toResponse(value: unknown): Promise<Response> {
  const v = value instanceof Promise ? await value : value;
  if (v instanceof Response) return v;
  if (v == null) return new Response(null, { status: 204 });
  if (typeof v === "string") {
    return new Response(v, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (
    v instanceof ArrayBuffer ||
    v instanceof Uint8Array ||
    v instanceof Blob ||
    v instanceof ReadableStream
  ) {
    return new Response(v as BodyInit);
  }

  return new Response(JSON.stringify(v), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * 启动静态文件开发服务器
 */
export function startDevServer(
  outDir: string,
  port: number,
  cwd: string,
  backendDir: string = "",
  backendStyle: string = "nextjs",
  cdnCacheDir?: string | null,
  offline = false,
) {
  let router: Bun.FileSystemRouter | undefined;
  let routerVersion = 0;
  if (!backendDir) backendDir = "backend";
  const backendDirAbs = resolve(cwd, backendDir);
  if (
    backendDirAbs &&
    existsSync(backendDirAbs) &&
    lstatSync(backendDirAbs).isDirectory()
  ) {
    router = new Bun.FileSystemRouter({
      style: backendStyle ?? "nextjs",
      dir: backendDirAbs,
    });
    console.log(
      `🛣️  API routes enabled: ${backendDirAbs} (style=${backendStyle})`,
    );

    watch(backendDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (ignored(rel)) return;
      if (!isRealChange(join(backendDir, rel))) return;
      router!.reload();
      routerVersion++;
      console.log(`api ${filename} changed: ${routerVersion}`);
    });
  }

  Bun.serve({
    port,
    async fetch(req) {
      // ---- /_cdn/<host>/<path> → lazy CDN proxy (offline cache) ----
      const url0 = new URL(req.url);
      if (cdnCacheDir && url0.pathname.startsWith("/_cdn/")) {
        const rest = decodeURIComponent(url0.pathname.slice("/_cdn/".length));
        const localPath = join(cdnCacheDir, rest);
        const localFile = Bun.file(localPath);
        if (await localFile.exists()) {
          return new Response(localFile);
        }
        if (offline) {
          return new Response("offline + uncached", { status: 504 });
        }
        const upstream = "https://" + rest + (url0.search || "");
        try {
          const res = await fetch(upstream, {
            redirect: "follow",
            headers: {
              "User-Agent":
                "Mozilla/5.0 (compatible; biu/1) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            },
          });
          if (!res.ok) {
            return new Response(`upstream ${res.status}`, {
              status: res.status,
            });
          }
          const buf = await res.arrayBuffer();
          await mkdir(dirname(localPath), { recursive: true });
          await Bun.write(localPath, buf);
          const headers = new Headers();
          const ct = res.headers.get("content-type");
          if (ct) headers.set("content-type", ct);
          return new Response(buf, { headers });
        } catch (err) {
          return new Response(
            `proxy error: ${(err as Error).message}`,
            { status: 502 },
          );
        }
      }

      // ---- API 路由 ----
      const matched = router?.match(req);
      if (matched) {
        try {
          const v = routerVersion;
          const importPath = v > 0
            ? `${matched.filePath}?v=${v}`
            : matched.filePath;
          const mod = await import(importPath);
          // Next.js 风格的方法导出（GET/POST/...）优先于 default
          const method = req.method.toUpperCase();
          const handler = (mod[method] as unknown) ?? mod.default;
          if (typeof handler !== "function") {
            return new Response(
              `Route ${matched.pathname} has no handler for ${method}`,
              { status: 405 },
            );
          }
          const ctx: RouteContext = {
            params: matched.params,
            query: matched.query,
            pathname: matched.pathname,
          };
          return await toResponse(handler(req, ctx));
        } catch (err) {
          console.error(
            `❌ Route handler error (${matched.filePath}):`,
            err,
          );
          return new Response("Internal Server Error", { status: 500 });
        }
      }

      // ---- 静态文件 ----
      const url = new URL(req.url);
      let pathname = decodeURIComponent(url.pathname);
      // 默认 / → /index.html
      if (pathname.endsWith("/")) pathname = `${pathname}index.html`;

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
    error(err) {
      console.error("❌ Server error:", err);
      return new Response("Internal Server Error", { status: 500 });
    },
  });
  console.log(
    `🌐 Serving ${relative(cwd, outDir)} at http://localhost:${port}`,
  );
  if (cdnCacheDir) {
    console.log(
      `☁️  CDN proxy: /_cdn/<host>/<path> → ${relative(cwd, cdnCacheDir)}` +
        (offline ? " (offline)" : ""),
    );
  }
}
