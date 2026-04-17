import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { buildProject } from "./builder.ts";

const demoSrc = resolve(import.meta.dir, "../demo-project/src");
const tmpOut = join(import.meta.dir, "__test_builder_out__");
const tmpInlineSrc = join(import.meta.dir, "__test_inline_src__");
const tmpInlineOut = join(import.meta.dir, "__test_inline_out__");

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

describe("buildProject — auto-inline", () => {
  beforeEach(async () => {
    await rm(tmpInlineSrc, { recursive: true, force: true });
    await rm(tmpInlineOut, { recursive: true, force: true });
    await mkdir(tmpInlineSrc, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpInlineSrc, { recursive: true, force: true });
    await rm(tmpInlineOut, { recursive: true, force: true });
  });

  test("basename not in HTML → auto inlined (no separate output)", async () => {
    // helper.ts is never mentioned in any HTML → should be inlined into app.ts
    await writeFile(
      join(tmpInlineSrc, "index.html"),
      `<html><body><script type="module" src="app.ts"></script></body></html>`,
    );
    await writeFile(
      join(tmpInlineSrc, "app.ts"),
      `import { greet } from "./helper.ts";\nconsole.log(greet());`,
    );
    await writeFile(
      join(tmpInlineSrc, "helper.ts"),
      `export function greet() { return "hello"; }`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    // Only app-xxx.js should exist, no helper-xxx.js
    expect(jsFiles.some((f) => f.startsWith("app-"))).toBe(true);
    expect(jsFiles.some((f) => f.startsWith("helper-"))).toBe(false);

    // The inlined content should be inside app's output
    const appJs = await readFile(
      join(tmpInlineOut, jsFiles.find((f) => f.startsWith("app-"))!),
      "utf8",
    );
    expect(appJs).toContain("hello");
  });

  test("basename appears in HTML → separate module output", async () => {
    // lib.ts is referenced from HTML → should stay as separate module
    await writeFile(
      join(tmpInlineSrc, "index.html"),
      `<html><body>
        <script type="module" src="app.ts"></script>
        <script type="module" src="lib.ts"></script>
      </body></html>`,
    );
    await writeFile(
      join(tmpInlineSrc, "app.ts"),
      `import { util } from "./lib.ts";\nconsole.log(util());`,
    );
    await writeFile(
      join(tmpInlineSrc, "lib.ts"),
      `export function util() { return "lib"; }`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    expect(jsFiles.some((f) => f.startsWith("app-"))).toBe(true);
    expect(jsFiles.some((f) => f.startsWith("lib-"))).toBe(true);
  });

  test("basename in inline script import → separate module", async () => {
    // shared.ts appears in HTML inline import → separate module
    await writeFile(
      join(tmpInlineSrc, "index.html"),
      `<html><body>
        <script type="module" src="entry.ts"></script>
        <script type="module">
          import { val } from "./shared.ts";
          console.log(val);
        </script>
      </body></html>`,
    );
    await writeFile(
      join(tmpInlineSrc, "entry.ts"),
      `import { val } from "./shared.ts";\nconsole.log(val);`,
    );
    await writeFile(
      join(tmpInlineSrc, "shared.ts"),
      `export const val = 42;`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    expect(jsFiles.some((f) => f.startsWith("shared-"))).toBe(true);
  });

  test("?? suffix forces inline even if basename is in HTML", async () => {
    // force.ts basename appears in HTML, but imported with ?? → still inlined
    await writeFile(
      join(tmpInlineSrc, "index.html"),
      `<html><body>
        <script type="module" src="app.ts"></script>
        <!-- force.ts mentioned here -->
      </body></html>`,
    );
    await writeFile(
      join(tmpInlineSrc, "app.ts"),
      `import { x } from "./force.ts??";\nconsole.log(x);`,
    );
    await writeFile(
      join(tmpInlineSrc, "force.ts"),
      `export const x = "forced";`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    expect(jsFiles.some((f) => f.startsWith("app-"))).toBe(true);
    expect(jsFiles.some((f) => f.startsWith("force-"))).toBe(false);

    const appJs = await readFile(
      join(tmpInlineOut, jsFiles.find((f) => f.startsWith("app-"))!),
      "utf8",
    );
    expect(appJs).toContain("forced");
  });

  test("deep dependency chain — transitive auto-inline", async () => {
    // a.ts → b.ts → c.ts, only a.ts in HTML; b.ts and c.ts should be inlined
    await writeFile(
      join(tmpInlineSrc, "index.html"),
      `<html><body><script type="module" src="a.ts"></script></body></html>`,
    );
    await writeFile(
      join(tmpInlineSrc, "a.ts"),
      `import { b } from "./b.ts";\nconsole.log(b);`,
    );
    await writeFile(
      join(tmpInlineSrc, "b.ts"),
      `import { c } from "./c.ts";\nexport const b = c + 1;`,
    );
    await writeFile(
      join(tmpInlineSrc, "c.ts"),
      `export const c = 100;`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    expect(jsFiles.some((f) => f.startsWith("a-"))).toBe(true);
    expect(jsFiles.some((f) => f.startsWith("b-"))).toBe(false);
    expect(jsFiles.some((f) => f.startsWith("c-"))).toBe(false);

    // All code should be bundled into a's output
    const aJs = await readFile(
      join(tmpInlineOut, jsFiles.find((f) => f.startsWith("a-"))!),
      "utf8",
    );
    expect(aJs).toContain("100");
  });

  test("subdirectory helper is auto-inlined", async () => {
    // sub/util.ts only imported by app.ts, not in HTML → inlined
    await mkdir(join(tmpInlineSrc, "sub"), { recursive: true });
    await writeFile(
      join(tmpInlineSrc, "index.html"),
      `<html><body><script type="module" src="app.ts"></script></body></html>`,
    );
    await writeFile(
      join(tmpInlineSrc, "app.ts"),
      `import { add } from "./sub/util.ts";\nconsole.log(add(1, 2));`,
    );
    await writeFile(
      join(tmpInlineSrc, "sub", "util.ts"),
      `export function add(a: number, b: number) { return a + b; }`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    expect(jsFiles.some((f) => f.startsWith("app-"))).toBe(true);
    expect(jsFiles.some((f) => f.includes("util-"))).toBe(false);
  });
});
