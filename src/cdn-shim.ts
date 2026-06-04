// biu — runtime shim injected into HTML for dynamic CDN URL handling.
//
// At build time, statically discoverable CDN URLs are rewritten in HTML/CSS/JS
// outputs to point to the local cache (e.g. /cdn/esm.sh/...). But code that
// dynamically loads CDN resources at runtime — `document.createElement('script')`,
// `el.src = 'https://...'`, `fetch('https://...')`, `new Image().src = ...`,
// `XMLHttpRequest.open` — is impossible to rewrite statically.
//
// This shim patches those entry points: when an absolute https:// URL is
// assigned, it consults `window.__BIU_CDN__` (manifest map) and either:
//   • redirects to the cached local path (offline-safe), or
//   • when `window.__BIU_CDN_PROXY__` is true (dev server), redirects to
//     `/_cdn/<host>/<path>` so the dev server can lazily fetch+cache, or
//   • leaves the URL untouched (production fallback).

/* eslint-disable */
function __biuCdnShim() {
  // @ts-ignore — runs in the browser
  const W = window as any;
  const MAP: Record<string, string> = W.__BIU_CDN__ || {};
  const PROXY: boolean = !!W.__BIU_CDN_PROXY__;
  const PROXY_PREFIX: string = W.__BIU_CDN_PROXY_PREFIX__ || "/_cdn/";

  function map(url: string): string {
    if (!url || typeof url !== "string") return url;
    if (!/^https?:\/\//i.test(url)) return url;
    if (MAP[url]) return MAP[url];
    // Try variants with/without trailing slash, with default search dropped.
    const noHash = url.replace(/#[\s\S]*$/, "");
    if (MAP[noHash]) return MAP[noHash];
    if (PROXY) {
      try {
        const u = new URL(url);
        if (u.host !== location.host) {
          return PROXY_PREFIX + u.host + u.pathname +
            (u.search || "") + (u.hash || "");
        }
      } catch (_e) {
        // ignore parse errors
      }
    }
    return url;
  }

  // ── Patch element src/href setters ─────────────────────────────────
  const TAGS = ["script", "link", "img", "iframe", "audio", "video", "source"];
  for (const tag of TAGS) {
    try {
      const ctorName = "HTML" +
        (tag === "iframe"
          ? "IFrame"
          : tag.charAt(0).toUpperCase() + tag.slice(1)) +
        "Element";
      const Ctor = (W as any)[ctorName];
      if (!Ctor || !Ctor.prototype) continue;
      const attr = tag === "link" ? "href" : "src";
      const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, attr);
      if (!desc || !desc.set || !desc.get) continue;
      Object.defineProperty(Ctor.prototype, attr, {
        configurable: true,
        enumerable: desc.enumerable,
        get(this: any) {
          return desc.get!.call(this);
        },
        set(this: any, value: any) {
          desc.set!.call(this, typeof value === "string" ? map(value) : value);
        },
      });
    } catch (_e) {
      // ignore — feature-detect failures are non-fatal
    }
  }

  // ── Patch setAttribute for src/href on any element ────────────────
  const origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name: string, value: any) {
    if (
      typeof value === "string" &&
      (name === "src" || name === "href" || name === "data-src")
    ) {
      return origSetAttr.call(this, name, map(value));
    }
    return origSetAttr.call(this, name, value);
  };

  // ── Patch fetch ───────────────────────────────────────────────────
  if (typeof W.fetch === "function") {
    const origFetch = W.fetch.bind(W);
    W.fetch = function (input: any, init?: any) {
      try {
        if (typeof input === "string") {
          return origFetch(map(input), init);
        }
        if (input && typeof input.url === "string") {
          const mapped = map(input.url);
          if (mapped !== input.url) {
            return origFetch(new Request(mapped, input), init);
          }
        }
      } catch (_e) {
        // fall through to original
      }
      return origFetch(input, init);
    };
  }

  // ── Patch XMLHttpRequest.open ─────────────────────────────────────
  if (typeof W.XMLHttpRequest === "function") {
    const origOpen = W.XMLHttpRequest.prototype.open;
    W.XMLHttpRequest.prototype.open = function (
      method: string,
      url: string,
      ...rest: any[]
    ) {
      const mapped = typeof url === "string" ? map(url) : url;
      return origOpen.call(this, method, mapped, ...rest);
    };
  }

  // ── Patch dynamic import via a global helper (best-effort) ────────
  // Native dynamic `import()` cannot be intercepted by JS. Code that wants
  // import() of CDN URLs should go through the import map (which is
  // statically rewritten at build time). We expose a small helper as a hint.
  W.__biuCdnResolve = map;
}
/* eslint-enable */

/**
 * Stringified shim — injected verbatim into HTML inside a `<script>` tag,
 * right after `<head>`. The manifest is emitted ahead of the IIFE as
 * `window.__BIU_CDN__ = {...};`.
 *
 * Whitespace is collapsed (but only outside string literals) to keep the
 * inlined HTML small.
 */
function compactJs(src: string): string {
  // Drop // line comments and /* */ block comments, then collapse runs of
  // whitespace OUTSIDE string literals. Conservative: parses literals.
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // line comment
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    // block comment
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    // string literal
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        const cc = src[i];
        out += cc;
        i++;
        if (cc === "\\" && i < src.length) {
          out += src[i];
          i++;
          continue;
        }
        if (cc === quote) break;
      }
      continue;
    }
    // collapse whitespace
    if (/\s/.test(c)) {
      out += " ";
      while (i < src.length && /\s/.test(src[i])) i++;
      continue;
    }
    out += c;
    i++;
  }
  return out.trim();
}

export const CDN_SHIM_SRC: string = compactJs(
  `(${__biuCdnShim.toString()})();`,
);
