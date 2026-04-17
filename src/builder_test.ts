import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { buildProject } from "./builder.ts";

const demoSrc = resolve(import.meta.dir, "../demo-project/src");
const tmpOut = join(import.meta.dir, "__test_builder_out__");

describe("buildProject — integration", () => {
  test("builds demo-project and produces expected outputs", async () => {
    try {
      await buildProject(demoSrc, tmpOut);

      // JS outputs should exist with content-hash filenames
      const jsFiles = await Array.fromAsync(
        new Bun.Glob("**/*.js").scan(tmpOut),
      );
      expect(jsFiles.length).toBeGreaterThanOrEqual(3); // main, test, demo, hello
      expect(jsFiles.some((f) => f.startsWith("main-"))).toBe(true);
      expect(jsFiles.some((f) => f.startsWith("test-"))).toBe(true);
      expect(jsFiles.some((f) => f.startsWith("demo-"))).toBe(true);

      // CSS outputs
      const cssFiles = await Array.fromAsync(
        new Bun.Glob("**/*.css").scan(tmpOut),
      );
      expect(cssFiles.length).toBeGreaterThanOrEqual(2);
      expect(cssFiles.some((f) => f.includes("styles-"))).toBe(true);
      expect(cssFiles.some((f) => f.includes("hey-"))).toBe(true);

      // HTML outputs
      expect(existsSync(join(tmpOut, "index.html"))).toBe(true);
      expect(existsSync(join(tmpOut, "test.html"))).toBe(true);
      expect(existsSync(join(tmpOut, "hey", "world.html"))).toBe(true);

      // Assets
      expect(existsSync(join(tmpOut, "favicon.ico"))).toBe(true);
      const pngFiles = await Array.fromAsync(
        new Bun.Glob("**/*.png").scan(tmpOut),
      );
      expect(pngFiles.some((f) => f.includes("mindon-"))).toBe(true);
    } finally {
      await rm(tmpOut, { recursive: true, force: true });
    }
  });

  test("HTML output references hashed JS files", async () => {
    try {
      await buildProject(demoSrc, tmpOut);

      const indexHtml = await readFile(join(tmpOut, "index.html"), "utf8");
      // Should reference hashed JS, not original .ts
      expect(indexHtml).not.toContain(".ts");
      expect(indexHtml).toMatch(/main-[0-9a-z]+\.js/);
      expect(indexHtml).toMatch(/hello-[0-9a-z]+\.js/);

      // Should reference hashed CSS, not original .scss
      expect(indexHtml).not.toContain(".scss");
      expect(indexHtml).toMatch(/styles-[0-9a-f]+\.css/);
    } finally {
      await rm(tmpOut, { recursive: true, force: true });
    }
  });

  test("CSS output contains minified content", async () => {
    try {
      await buildProject(demoSrc, tmpOut);

      const cssFiles = await Array.fromAsync(
        new Bun.Glob("styles-*.css").scan(tmpOut),
      );
      expect(cssFiles.length).toBe(1);
      const css = await readFile(join(tmpOut, cssFiles[0]), "utf8");
      // Should be minified (no extra whitespace)
      expect(css).not.toContain("  ");
      expect(css).toContain("font:");
      expect(css).toContain("color:#333");
    } finally {
      await rm(tmpOut, { recursive: true, force: true });
    }
  });

  test("CSS url() references are updated to hashed asset paths", async () => {
    try {
      await buildProject(demoSrc, tmpOut);

      const cssFiles = await Array.fromAsync(
        new Bun.Glob("styles-*.css").scan(tmpOut),
      );
      const css = await readFile(join(tmpOut, cssFiles[0]), "utf8");
      // url() should point to hashed asset, not original
      expect(css).not.toContain("mindon.png");
      expect(css).toMatch(/mindon-[0-9a-f]+\.png/);
    } finally {
      await rm(tmpOut, { recursive: true, force: true });
    }
  });

  test("subdirectory HTML output references correct relative paths", async () => {
    try {
      await buildProject(demoSrc, tmpOut);

      const worldHtml = await readFile(
        join(tmpOut, "hey", "world.html"),
        "utf8",
      );
      // Should reference parent dir CSS/JS with correct relative paths
      expect(worldHtml).toMatch(/styles-[0-9a-f]+\.css/);
      expect(worldHtml).toMatch(/hello-[0-9a-z]+\.js/);
      expect(worldHtml).toMatch(/demo-[0-9a-z]+\.js/);
    } finally {
      await rm(tmpOut, { recursive: true, force: true });
    }
  });
});
