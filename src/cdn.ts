// biu — CDN URL extraction, local fs caching, and rewrite helpers
//
// Goals:
//   1) Discover all CDN (https://...) URLs referenced by HTML / CSS / JS / TS
//      sources and importmaps in the project.
//   2) Recursively fetch them to a local cache directory; recurse into the
//      bodies of fetched JS/CSS to follow nested imports / url(...) so that
//      the cache is fully self-contained and works offline.
//   3) Provide rewriting helpers so build output references local cache paths
//      (e.g. "/cdn/esm.sh/react@18.3.1/index.js") instead of the original
//      remote URLs, with a runtime fallback shim handling dynamic loads.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, extname, join, posix, relative } from "node:path";

import { CDN_SHIM_SRC } from "./cdn-shim.ts";
import { scan } from "./utils.ts";
import { isDataUrl, isHttpUrl, scanCssUrls } from "./css-urls.ts";

// ─── URL-extraction regexes ──────────────────────────────────────────

// HTML attributes: <script src="..."> / <link href="..."> / <img src="...">
// (also catches preload / iframe / video etc.)
const RE_HTML_ATTR =
  /(?:src|href|data-src)\s*=\s*["'](https?:\/\/[^"'\s>]+)["']/gi;

// Bare `@import "https://..."` values; url(...) values use scanCssUrls().
const RE_CSS_IMPORT_BARE = /@import\s+["'](https?:\/\/[^"']+)["']/gi;

// JS/TS: import "...", import x from "...", export ... from "...", import("...")
const RE_JS_IMPORT_FROM =
  /\b(?:import|export)\b[^"';]*?\bfrom\s*["'](https?:\/\/[^"']+)["']/g;
const RE_JS_IMPORT_BARE = /\bimport\s*["'](https?:\/\/[^"']+)["']/g;
const RE_JS_IMPORT_DYN = /\bimport\s*\(\s*["'](https?:\/\/[^"']+)["']/g;
const RE_JS_NEW_URL = /\bnew\s+URL\s*\(\s*["'](https?:\/\/[^"']+)["']/g;

// JS literal CDN URL with file-like extension. Conservative on purpose —
// catches `s.src = "https://cdn/foo.js"`, `loadCss("https://cdn/foo.css")`,
// dynamic createElement assignments, etc., while avoiding random link strings.
const RE_JS_LITERAL_FILE =
  /["'`](https?:\/\/[^\s"'`<>]+?\.(?:m?[jt]sx?|css|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|avif|wasm|json|map|html?))(?:\?[^\s"'`<>]*)?["'`]/gi;

// importmap value — any JSON value-side URL
const RE_JSON_VALUE_URL = /["'][^"'\n]+["']\s*:\s*["'](https?:\/\/[^"']+)["']/g;
const IMPORTMAP_BLOCK_RE =
  /<script\b(?=[^>]*\btype\s*=\s*["']?importmap["']?)[^>]*>([\s\S]*?)<\/script>/gi;

function pushAll(re: RegExp, src: string, out: Set<string>) {
  for (const m of src.matchAll(re)) out.add(m[1]);
}

/** Extract every absolute https:// URL referenced inside an HTML document. */
export function extractHtmlCdnUrls(html: string): Set<string> {
  const out = new Set<string>();
  pushAll(RE_HTML_ATTR, html, out);
  for (const block of html.matchAll(IMPORTMAP_BLOCK_RE)) {
    const json = block[1]?.trim();
    if (!json) continue;
    try {
      const parsed = JSON.parse(json);
      const harvest = (v: unknown) => {
        if (typeof v === "string" && /^https?:\/\//.test(v)) out.add(v);
        else if (v && typeof v === "object") {
          for (const x of Object.values(v as Record<string, unknown>)) {
            harvest(x);
          }
        }
      };
      harvest(parsed);
    } catch {
      pushAll(RE_JSON_VALUE_URL, json, out);
    }
  }
  return out;
}

/** Extract every absolute https:// URL referenced inside a CSS file. */
export function extractCssCdnUrls(css: string): Set<string> {
  const out = new Set<string>();
  for (const { value } of scanCssUrls(css)) {
    if (isHttpUrl(value)) out.add(value);
  }
  pushAll(RE_CSS_IMPORT_BARE, css, out);
  return out;
}

/** Extract every absolute https:// URL referenced inside a JS/TS file. */
export function extractJsCdnUrls(js: string): Set<string> {
  const out = new Set<string>();
  pushAll(RE_JS_IMPORT_FROM, js, out);
  pushAll(RE_JS_IMPORT_BARE, js, out);
  pushAll(RE_JS_IMPORT_DYN, js, out);
  pushAll(RE_JS_NEW_URL, js, out);
  pushAll(RE_JS_LITERAL_FILE, js, out);
  return out;
}

// ─── URL → cache-relative path mapping ───────────────────────────────

/**
 * Convert an absolute URL to a deterministic, filesystem-safe cache path.
 * Examples:
 *   https://esm.sh/react@18.3.1/index.js      → esm.sh/react@18.3.1/index.js
 *   https://esm.sh/foo?dev                    → esm.sh/foo/_dev
 *   https://cdn/x.css?v=1                     → cdn/x@v_1.css
 */
export function urlToCachePath(url: string): string {
  const u = new URL(url);
  let p = (u.host + u.pathname).replace(/\/+/g, "/");
  if (p.endsWith("/")) p += "index";
  if (u.search) {
    const safe = u.search.slice(1).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(
      0,
      96,
    );
    const ext = extname(p);
    if (ext) p = p.slice(0, -ext.length) + "@" + safe + ext;
    else p = p + "/_" + safe;
  }
  return p;
}

// ─── Recursive fetch + cache ─────────────────────────────────────────

export interface CdnCacheOptions {
  /** Local fs directory used as cache root */
  cacheDir: string;
  /** When true, never hit the network — only use cache; warn on misses. */
  offline: boolean;
  /** Optional fetch (overridable for tests) */
  fetcher?: typeof fetch;
}

/** url → cache-relative path */
export type CdnManifest = Record<string, string>;

function isJsLike(ct: string | null, urlPath: string): boolean {
  if (ct && /(?:javascript|ecmascript|typescript)/i.test(ct)) return true;
  return /\.(m?[jt]sx?)(?:\?|$)/i.test(urlPath);
}
function isCssLike(ct: string | null, urlPath: string): boolean {
  if (ct && /text\/css/i.test(ct)) return true;
  return /\.css(?:\?|$)/i.test(urlPath);
}

const RE_REL_JS =
  /(?:\b(?:import|export)\b[^"';]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.{1,2}\/[^"']+)["']/g;
const RE_REL_CSS_IMPORT = /@import\s+["'](\.{0,2}\/?[^"']+)["']/gi;

/**
 * Recursively fetch URLs into the local cache, walking JS/CSS bodies for
 * nested deps. Returns a manifest of every cached URL.
 */
export async function fetchAndCacheAll(
  initial: Iterable<string>,
  opts: CdnCacheOptions,
): Promise<CdnManifest> {
  const fetcher = opts.fetcher ?? fetch;
  const manifest: CdnManifest = {};
  const queued = new Set<string>();
  let frontier: string[] = [];
  for (const u of initial) {
    if (!queued.has(u)) {
      queued.add(u);
      frontier.push(u);
    }
  }

  const processOne = async (url: string): Promise<string[]> => {
    const rel = urlToCachePath(url);
    const localPath = join(opts.cacheDir, rel);
    let body: ArrayBuffer | null = null;
    let contentType: string | null = null;

    if (existsSync(localPath)) {
      manifest[url] = rel;
      try {
        body = await Bun.file(localPath).arrayBuffer();
      } catch {
        body = null;
      }
    } else if (opts.offline) {
      console.warn(`⚠️  CDN offline: ${url} not cached`);
      return [];
    } else {
      try {
        const res = await fetcher(url, {
          redirect: "follow",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; biu/1) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          },
        });
        if (!res.ok) {
          console.warn(`⚠️  CDN fetch ${url} → ${res.status}`);
          return [];
        }
        contentType = res.headers.get("content-type");
        body = await res.arrayBuffer();
        await mkdir(dirname(localPath), { recursive: true });
        await Bun.write(localPath, body);
        manifest[url] = rel;
      } catch (err) {
        console.warn(
          `⚠️  CDN fetch ${url} failed: ${(err as Error).message}`,
        );
        return [];
      }
    }

    if (!body) return [];
    const u = new URL(url);
    const isJs = isJsLike(contentType, u.pathname);
    const isCss = isCssLike(contentType, u.pathname);
    if (!isJs && !isCss) return [];

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(
        new Uint8Array(body),
      );
    } catch {
      return [];
    }

    const inner = isJs ? extractJsCdnUrls(text) : extractCssCdnUrls(text);

    // Resolve relative URLs against the source URL → absolute CDN URLs.
    if (isJs) {
      for (const m of text.matchAll(RE_REL_JS)) {
        try {
          const abs = new URL(m[1], url).toString();
          if (/^https?:\/\//.test(abs)) inner.add(abs);
        } catch {
          // ignore unresolvable
        }
      }
    } else {
      for (const { value } of scanCssUrls(text)) {
        if (
          isDataUrl(value) || isHttpUrl(value) ||
          /^(?:\/\/|#|[a-z][a-z0-9+.-]*:)/i.test(value)
        ) continue;
        try {
          const abs = new URL(value, url).toString();
          if (/^https?:\/\//.test(abs)) inner.add(abs);
        } catch {
          // ignore
        }
      }
      for (const m of text.matchAll(RE_REL_CSS_IMPORT)) {
        try {
          const abs = new URL(m[1], url).toString();
          if (/^https?:\/\//.test(abs)) inner.add(abs);
        } catch {
          // ignore
        }
      }
      // sourceMappingURL inside CSS (rare — skip).
    }

    // Source maps inside JS — tracked but typically optional. Off by default.
    return [...inner];
  };

  while (frontier.length > 0) {
    const results = await Promise.all(frontier.map(processOne));
    const next: string[] = [];
    for (const list of results) {
      for (const u of list) {
        if (!queued.has(u)) {
          queued.add(u);
          next.push(u);
        }
      }
    }
    frontier = next;
  }

  return manifest;
}

// ─── Manifest persistence ────────────────────────────────────────────

export async function loadManifest(cacheDir: string): Promise<CdnManifest> {
  const file = join(cacheDir, "manifest.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await Bun.file(file).text()) as CdnManifest;
  } catch {
    return {};
  }
}

export async function saveManifest(
  cacheDir: string,
  manifest: CdnManifest,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await Bun.write(
    join(cacheDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

// ─── Rewrite helpers ─────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace literal CDN URLs in `content` with the given `prefix` + cache-relative
 * path (e.g. prefix="/cdn/" → "/cdn/esm.sh/react@.../index.js").
 *
 * Longest URL first to avoid partial-prefix collisions on related CDNs.
 */
export function rewriteCdnUrls(
  content: string,
  manifest: CdnManifest,
  prefix: string,
): string {
  const urls = Object.keys(manifest).sort((a, b) => b.length - a.length);
  if (urls.length === 0) return content;
  const norm = prefix.replace(/\/+$/, "") + "/";
  let out = content;
  for (const url of urls) {
    const local = manifest[url];
    if (!local) continue;
    out = out.replace(new RegExp(escapeRegex(url), "g"), norm + local);
  }
  return out;
}

/**
 * Rewrite CDN URLs inside a file that itself lives at `<cacheDir>/<filePathInCache>`.
 * Output references are written as cache-internal relative paths so that the
 * cache directory is self-contained when copied to <outDir>/cdn/.
 */
export function rewriteCachedFile(
  content: string,
  filePathInCache: string,
  manifest: CdnManifest,
): string {
  const urls = Object.keys(manifest).sort((a, b) => b.length - a.length);
  if (urls.length === 0) return content;
  const fileDir = posix.dirname(filePathInCache.replace(/\\/g, "/"));
  let out = content;
  for (const url of urls) {
    const target = manifest[url].replace(/\\/g, "/");
    let rel = posix.relative(fileDir, target);
    if (!rel.startsWith(".")) rel = "./" + rel;
    out = out.replace(new RegExp(escapeRegex(url), "g"), rel);
  }
  return out;
}

// ─── Cache directory sync (cacheDir → outDir/cdn) ────────────────────

/**
 * Mirror missing files from `srcCache` into `dstCache`, preserving relative
 * structure. Files that already exist with the same byte length are skipped.
 * Avoids rewriting on every build to keep watch mode fast.
 */
async function syncCacheDir(
  srcCache: string,
  dstCache: string,
): Promise<number> {
  if (!existsSync(srcCache)) return 0;
  const files = await scan(srcCache);
  let copied = 0;
  await Promise.all(files.map(async (src) => {
    const rel = relative(srcCache, src);
    const dst = join(dstCache, rel);
    if (existsSync(dst)) {
      const [a, b] = await Promise.all([
        Bun.file(src).size,
        Bun.file(dst).size,
      ]);
      if (a === b) return;
    }
    await mkdir(dirname(dst), { recursive: true });
    await Bun.write(dst, Bun.file(src));
    copied++;
  }));
  return copied;
}

// ─── HTML shim injection ─────────────────────────────────────────────

/**
 * Inject the runtime shim + manifest map into HTML. Idempotent — looks for a
 * `data-biu-cdn` marker and re-injects in place if present.
 */
export function injectCdnShim(
  html: string,
  manifest: CdnManifest,
  prefix: string,
  proxyFallback: boolean,
  proxyPrefix = "/_cdn/",
): string {
  const norm = prefix.replace(/\/+$/, "") + "/";
  const map: Record<string, string> = {};
  for (const [url, rel] of Object.entries(manifest)) map[url] = norm + rel;
  const decl = [
    `window.__BIU_CDN__=${JSON.stringify(map)};`,
    proxyFallback ? `window.__BIU_CDN_PROXY__=true;` : "",
    proxyFallback
      ? `window.__BIU_CDN_PROXY_PREFIX__=${JSON.stringify(proxyPrefix)};`
      : "",
  ].filter(Boolean).join("");
  const tag = `<script data-biu-cdn>${decl}${CDN_SHIM_SRC}</script>`;

  // Replace any pre-existing biu-cdn shim
  const existing = /<script\s+data-biu-cdn[^>]*>[\s\S]*?<\/script>/i;
  if (existing.test(html)) return html.replace(existing, tag);

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b([^>]*)>/i, `<head$1>${tag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b([^>]*)>/i, `<html$1>${tag}`);
  }
  return tag + html;
}

// ─── Build-time pipeline orchestrator ────────────────────────────────

export interface CdnPipelineOptions {
  /** Persistent cache (where remote files are downloaded to). */
  cacheDir: string;
  /** Build output directory; cache is mirrored to <outDir>/cdn/. */
  outDir: string;
  /** Skip network entirely; warn on misses. */
  offline: boolean;
}

export interface CdnPipelineResult {
  manifest: CdnManifest;
  /** Number of distinct CDN URLs discovered in source. */
  discovered: number;
  /** Number of URLs successfully cached (after recursive walk). */
  cached: number;
  /** New files copied from cacheDir to outDir/cdn this build. */
  copied: number;
}

/**
 * Discover CDN URLs in src files, fetch+cache them recursively, rewrite
 * cached JS/CSS bodies to refer to cache siblings, then mirror cache → outDir.
 */
export async function runCdnPipeline(
  htmlContents: { file: string; content: string }[],
  styleFiles: string[],
  jsFiles: string[],
  opts: CdnPipelineOptions,
): Promise<CdnPipelineResult> {
  const urls = new Set<string>();

  for (const { content } of htmlContents) {
    for (const u of extractHtmlCdnUrls(content)) urls.add(u);
  }

  await Promise.all([
    ...jsFiles.map(async (f) => {
      try {
        const code = await Bun.file(f).text();
        for (const u of extractJsCdnUrls(code)) urls.add(u);
      } catch {
        // ignore unreadable files
      }
    }),
    ...styleFiles.map(async (f) => {
      try {
        const code = await Bun.file(f).text();
        for (const u of extractCssCdnUrls(code)) urls.add(u);
      } catch {
        // ignore
      }
    }),
  ]);

  if (urls.size === 0) {
    return { manifest: {}, discovered: 0, cached: 0, copied: 0 };
  }

  // Merge with previously persisted manifest (so we don't re-fetch known URLs
  // during repeated builds even after network drops out).
  const previous = await loadManifest(opts.cacheDir);
  const manifest = await fetchAndCacheAll(urls, {
    cacheDir: opts.cacheDir,
    offline: opts.offline,
  });
  for (const [url, rel] of Object.entries(previous)) {
    if (!manifest[url] && existsSync(join(opts.cacheDir, rel))) {
      manifest[url] = rel;
    }
  }

  // Rewrite each cached JS/CSS so that internal refs to other CDN URLs go
  // through cache-internal relative paths. Idempotent.
  await Promise.all(
    Object.values(manifest).map(async (rel) => {
      const ext = extname(rel).toLowerCase();
      if (!/\.(m?[jt]sx?|css|map)$/.test(ext)) return;
      const local = join(opts.cacheDir, rel);
      if (!existsSync(local)) return;
      try {
        const text = await Bun.file(local).text();
        const rewritten = rewriteCachedFile(text, rel, manifest);
        if (rewritten !== text) await Bun.write(local, rewritten);
      } catch {
        // ignore — binary file or read error
      }
    }),
  );

  await saveManifest(opts.cacheDir, manifest);

  // Mirror to outDir/cdn (skip if cacheDir is already inside outDir/cdn).
  const outCdn = join(opts.outDir, "cdn");
  let copied = 0;
  if (opts.cacheDir !== outCdn) {
    copied = await syncCacheDir(opts.cacheDir, outCdn);
    // Manifest copy too, so dev server can read it
    if (existsSync(join(opts.cacheDir, "manifest.json"))) {
      await mkdir(outCdn, { recursive: true });
      await Bun.write(
        join(outCdn, "manifest.json"),
        Bun.file(join(opts.cacheDir, "manifest.json")),
      );
    }
  }

  return {
    manifest,
    discovered: urls.size,
    cached: Object.keys(manifest).length,
    copied,
  };
}

/**
 * Walk every output HTML/CSS/JS file under `outDir` (excluding outDir/cdn/),
 * replace literal CDN URL strings with `/cdn/<host>/<path>`, and inject the
 * runtime shim into HTML files.
 */
export async function rewriteCdnInOutputs(
  outDir: string,
  manifest: CdnManifest,
  proxyFallback: boolean,
): Promise<{ html: number; css: number; js: number; changedJs: string[] }> {
  if (Object.keys(manifest).length === 0) {
    return { html: 0, css: 0, js: 0, changedJs: [] };
  }
  const cdnDir = join(outDir, "cdn");
  const all = await scan(outDir);
  const changedJs: string[] = [];
  let html = 0, css = 0, js = 0;

  await Promise.all(all.map(async (file) => {
    if (file.startsWith(cdnDir)) return; // skip the cache itself
    const ext = extname(file).toLowerCase();
    if (![".html", ".htm", ".css", ".js", ".mjs"].includes(ext)) return;

    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      return;
    }

    // Page-relative root path for the cdn dir
    const pageRel = relative(dirname(file), cdnDir);
    const prefix = pageRel.startsWith(".") ? pageRel : "./" + pageRel;
    let rewritten = rewriteCdnUrls(content, manifest, prefix);

    if (ext === ".html" || ext === ".htm") {
      rewritten = injectCdnShim(rewritten, manifest, prefix, proxyFallback);
    }

    if (rewritten !== content) {
      await Bun.write(file, rewritten);
      if (ext === ".html" || ext === ".htm") html++;
      else if (ext === ".css") css++;
      else {
        js++;
        changedJs.push(file);
      }
    }
  }));

  return { html, css, js, changedJs };
}
