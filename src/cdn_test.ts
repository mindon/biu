import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractCssCdnUrls,
  extractHtmlCdnUrls,
  extractJsCdnUrls,
  fetchAndCacheAll,
  injectCdnShim,
  rewriteCachedFile,
  rewriteCdnUrls,
  urlToCachePath,
} from "./cdn.ts";

describe("cdn URL extraction", () => {
  test("extracts <script src> / <link href> / importmap value URLs from HTML", () => {
    const html = `
      <script type="importmap">
      { "imports": {
          "react": "https://esm.sh/react@18.3.1",
          "lib/": "https://cdn.jsdelivr.net/npm/lib/"
      } }
      </script>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
      <script src="https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js"></script>
      <img src="https://example.com/logo.png">
    `;
    const urls = extractHtmlCdnUrls(html);
    expect(urls.has("https://esm.sh/react@18.3.1")).toBe(true);
    expect(urls.has("https://cdn.jsdelivr.net/npm/lib/")).toBe(true);
    expect(urls.has("https://fonts.googleapis.com/css2?family=Inter")).toBe(
      true,
    );
    expect(
      urls.has(
        "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js",
      ),
    ).toBe(true);
    expect(urls.has("https://example.com/logo.png")).toBe(true);
  });

  test("recovers importmap URLs even from non-strict JSON", () => {
    const html = `
      <script type="importmap">
      { "imports": {
          // comment (invalid JSON)
          "react": "https://esm.sh/react@18",
      } }
      </script>
    `;
    const urls = extractHtmlCdnUrls(html);
    expect(urls.has("https://esm.sh/react@18")).toBe(true);
  });

  test("extracts url() and @import https from CSS", () => {
    const css = `
      @import "https://fonts.googleapis.com/css2?family=Inter";
      .x { background: url(https://cdn.example.com/bg.png) no-repeat; }
      .y { background: url("https://cdn.example.com/bg2.png"); }
      .z { background: url('data:image/svg+xml;base64,abc'); }
    `;
    const urls = extractCssCdnUrls(css);
    expect(urls.has("https://fonts.googleapis.com/css2?family=Inter")).toBe(
      true,
    );
    expect(urls.has("https://cdn.example.com/bg.png")).toBe(true);
    expect(urls.has("https://cdn.example.com/bg2.png")).toBe(true);
    // data: must not be captured
    for (const u of urls) expect(u.startsWith("data:")).toBe(false);
  });

  test("extracts import / dynamic import / new URL / dynamic literal from JS", () => {
    const js = `
      import three from "https://esm.sh/three@0.160";
      import { x } from 'https://esm.sh/util';
      const Comp = await import("https://esm.sh/preact");
      export { foo } from "https://esm.sh/foo";
      const w = new URL("https://cdn.example.com/worker.js", import.meta.url);
      const s = document.createElement('script');
      s.src = "https://cdn.example.com/dyn.js";
      document.head.appendChild(s);
      loadCss('https://cdn.example.com/dyn.css');
    `;
    const urls = extractJsCdnUrls(js);
    expect(urls.has("https://esm.sh/three@0.160")).toBe(true);
    expect(urls.has("https://esm.sh/util")).toBe(true);
    expect(urls.has("https://esm.sh/preact")).toBe(true);
    expect(urls.has("https://esm.sh/foo")).toBe(true);
    expect(urls.has("https://cdn.example.com/worker.js")).toBe(true);
    expect(urls.has("https://cdn.example.com/dyn.js")).toBe(true);
    expect(urls.has("https://cdn.example.com/dyn.css")).toBe(true);
  });
});

describe("urlToCachePath", () => {
  test("plain URL → host/path", () => {
    expect(urlToCachePath("https://esm.sh/react@18.3.1/index.js"))
      .toBe("esm.sh/react@18.3.1/index.js");
  });
  test("query string is preserved as a stable suffix", () => {
    const p = urlToCachePath("https://cdn.example.com/foo.js?dev");
    expect(p.startsWith("cdn.example.com/foo")).toBe(true);
    expect(p.endsWith(".js")).toBe(true);
    expect(p.includes("@")).toBe(true);
  });
  test("trailing slash gets index", () => {
    expect(urlToCachePath("https://cdn.example.com/lib/"))
      .toBe("cdn.example.com/lib/index");
  });
});

describe("rewriteCdnUrls", () => {
  test("longest-first replacement avoids partial collisions", () => {
    const manifest = {
      "https://esm.sh/react": "esm.sh/react",
      "https://esm.sh/react@18.3.1": "esm.sh/react@18.3.1",
    };
    const out = rewriteCdnUrls(
      `import "https://esm.sh/react@18.3.1"; import "https://esm.sh/react";`,
      manifest,
      "/cdn/",
    );
    expect(out).toContain("/cdn/esm.sh/react@18.3.1");
    expect(out).toContain("/cdn/esm.sh/react");
    expect(out).not.toContain("https://esm.sh");
  });
});

describe("rewriteCachedFile", () => {
  test("rewrites to cache-internal relative paths", () => {
    const manifest = {
      "https://esm.sh/dep.js": "esm.sh/dep.js",
      "https://other.cdn/x.js": "other.cdn/x.js",
    };
    const text =
      `import "https://esm.sh/dep.js"; import "https://other.cdn/x.js";`;
    const out = rewriteCachedFile(text, "esm.sh/main.js", manifest);
    expect(out).toContain("./dep.js");
    expect(out).toContain("../other.cdn/x.js");
  });
});

describe("injectCdnShim", () => {
  test("injects after <head>", () => {
    const html =
      `<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>`;
    const out = injectCdnShim(
      html,
      { "https://esm.sh/react": "esm.sh/react" },
      "/cdn/",
      false,
    );
    expect(out).toMatch(/<head>\s*<script\s+data-biu-cdn>/);
    expect(out).toContain("__BIU_CDN__");
  });

  test("idempotent when re-injected", () => {
    const manifest = { "https://a/b": "a/b" };
    const html = `<html><head></head></html>`;
    const once = injectCdnShim(html, manifest, "/cdn/", false);
    const twice = injectCdnShim(once, manifest, "/cdn/", false);
    // Should only contain a single biu-cdn shim block
    expect(twice.match(/data-biu-cdn/g)?.length).toBe(1);
  });

  test("emits proxy fallback flag in dev mode", () => {
    const out = injectCdnShim(
      `<html><head></head></html>`,
      {},
      "/cdn/",
      true,
    );
    expect(out).toContain("__BIU_CDN_PROXY__");
  });
});

describe("fetchAndCacheAll (mocked fetcher)", () => {
  test("recursively walks JS/CSS bodies + persists to disk", async () => {
    const dir = join(tmpdir(), `biu-cdn-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });

    const remote: Record<string, { body: string; ct: string }> = {
      "https://x.cdn/main.js": {
        ct: "application/javascript",
        body: `import dep from "https://x.cdn/dep.js"; import "./inline.js";`,
      },
      "https://x.cdn/dep.js": {
        ct: "application/javascript",
        body: `export const v = 1;`,
      },
      "https://x.cdn/inline.js": {
        ct: "application/javascript",
        body: `// nested rel`,
      },
      "https://x.cdn/styles.css": {
        ct: "text/css",
        body:
          `@import "https://x.cdn/font.css"; .a{background:url(https://x.cdn/img.png)}`,
      },
      "https://x.cdn/font.css": { ct: "text/css", body: "" },
      "https://x.cdn/img.png": {
        ct: "image/png",
        body: "binary-bytes",
      },
    };

    const fakeFetch: typeof fetch = async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      const r = remote[url];
      if (!r) return new Response("not found", { status: 404 });
      return new Response(r.body, {
        status: 200,
        headers: { "content-type": r.ct },
      });
    };

    try {
      const manifest = await fetchAndCacheAll(
        ["https://x.cdn/main.js", "https://x.cdn/styles.css"],
        { cacheDir: dir, offline: false, fetcher: fakeFetch },
      );

      // All known URLs should be cached
      for (const url of Object.keys(remote)) {
        expect(manifest[url], `missing: ${url}`).toBeDefined();
        expect(existsSync(join(dir, manifest[url]))).toBe(true);
      }

      // dep.js was discovered through main.js — recursive walk works
      expect(manifest["https://x.cdn/dep.js"]).toBe("x.cdn/dep.js");
      // font.css discovered through @import
      expect(manifest["https://x.cdn/font.css"]).toBe("x.cdn/font.css");
      // img.png discovered through url()
      expect(manifest["https://x.cdn/img.png"]).toBe("x.cdn/img.png");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("offline mode never hits the network", async () => {
    const dir = join(tmpdir(), `biu-cdn-test-offline-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    let hits = 0;
    const fakeFetch: typeof fetch = async () => {
      hits++;
      return new Response("", { status: 200 });
    };
    try {
      const manifest = await fetchAndCacheAll(
        ["https://nope.example/foo.js"],
        { cacheDir: dir, offline: true, fetcher: fakeFetch },
      );
      expect(hits).toBe(0);
      expect(manifest["https://nope.example/foo.js"]).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
