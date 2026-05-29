import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
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
      expect(jsFiles.some((f) => /^main[.\-]/.test(f))).toBe(true);
      expect(jsFiles.some((f) => /^test[.\-]/.test(f))).toBe(true);
      expect(jsFiles.some((f) => /^demo[.\-]/.test(f))).toBe(true);

      // CSS outputs
      const cssFiles = await Array.fromAsync(
        new Bun.Glob("**/*.css").scan(tmpOut),
      );
      expect(cssFiles.length).toBeGreaterThanOrEqual(2);
      expect(cssFiles.some((f) => /styles[.\-]/.test(f))).toBe(true);
      expect(cssFiles.some((f) => /hey[.\-]/.test(f))).toBe(true);

      // HTML outputs
      expect(existsSync(join(tmpOut, "index.html"))).toBe(true);
      expect(existsSync(join(tmpOut, "test.html"))).toBe(true);
      expect(existsSync(join(tmpOut, "hey", "world.html"))).toBe(true);

      // Assets
      expect(existsSync(join(tmpOut, "favicon.ico"))).toBe(true);
      const pngFiles = await Array.fromAsync(
        new Bun.Glob("**/*.png").scan(tmpOut),
      );
      expect(pngFiles.some((f) => /mindon[.\-]/.test(f))).toBe(true);
    } finally {
      await rm(tmpOut, { recursive: true, force: true });
    }
  });

  test("HTML output references hashed JS files", async () => {
    try {
      await buildProject(demoSrc, tmpOut);

      const indexHtml = await Bun.file(join(tmpOut, "index.html")).text();
      // Should reference hashed JS, not original .ts
      expect(indexHtml).not.toContain(".ts");
      expect(indexHtml).toMatch(/main[.\-][0-9a-z]+\.js/);
      expect(indexHtml).toMatch(/hello[.\-][0-9a-z]+\.js/);

      // Should reference hashed CSS, not original .scss
      expect(indexHtml).not.toContain(".scss");
      expect(indexHtml).toMatch(/styles[.\-][0-9a-f]+\.css/);
    } finally {
      await rm(tmpOut, { recursive: true, force: true });
    }
  });

  test("inline <script type=module> imports keep './' prefix for same-dir files", async () => {
    try {
      await buildProject(demoSrc, tmpOut);

      const worldHtml = await Bun.file(join(tmpOut, "hey", "world.html"))
        .text();
      // ES module specifiers must start with "/", "./" or "../" — a bare
      // "world2.<hash>.js" would throw `Failed to resolve module specifier`.
      expect(worldHtml).toMatch(
        /\bfrom\s*["']\.\/world2[.\-][0-9a-z]+\.js["']/,
      );
      // Must NOT produce a bare specifier import.
      expect(worldHtml).not.toMatch(
        /\bfrom\s*["']world2[.\-][0-9a-z]+\.js/,
      );
    } finally {
      await rm(tmpOut, { recursive: true, force: true });
    }
  });

  test("CSS output contains minified content", async () => {
    try {
      await buildProject(demoSrc, tmpOut);

      const cssFiles = await Array.fromAsync(
        new Bun.Glob("styles[-.]*.css").scan(tmpOut),
      );
      expect(cssFiles.length).toBe(1);
      const css = await Bun.file(join(tmpOut, cssFiles[0])).text();
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
        new Bun.Glob("styles[-.]*.css").scan(tmpOut),
      );
      const css = await Bun.file(join(tmpOut, cssFiles[0])).text();
      // url() should point to hashed asset, not original
      expect(css).not.toContain("mindon.png");
      expect(css).toMatch(/mindon[.\-][0-9a-f]+\.png/);
    } finally {
      await rm(tmpOut, { recursive: true, force: true });
    }
  });

  test("subdirectory HTML output references correct relative paths", async () => {
    try {
      await buildProject(demoSrc, tmpOut);

      const worldHtml = await Bun.file(
        join(tmpOut, "hey", "world.html"),
      ).text();
      // Should reference parent dir CSS/JS with correct relative paths
      expect(worldHtml).toMatch(/styles[.\-][0-9a-f]+\.css/);
      expect(worldHtml).toMatch(/hello[.\-][0-9a-z]+\.js/);
      expect(worldHtml).toMatch(/demo[.\-][0-9a-z]+\.js/);
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
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body><script type="module" src="app.ts"></script></body></html>`,
    );
    await Bun.write(
      join(tmpInlineSrc, "app.ts"),
      `import { greet } from "./helper.ts";\nconsole.log(greet());`,
    );
    await Bun.write(
      join(tmpInlineSrc, "helper.ts"),
      `export function greet() { return "hello"; }`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    // Only app-xxx.js should exist, no helper-xxx.js
    expect(jsFiles.some((f) => /^app[.\-]/.test(f))).toBe(true);
    expect(jsFiles.some((f) => /^helper[.\-]/.test(f))).toBe(false);

    // The inlined content should be inside app's output
    const appJs = await Bun.file(
      join(tmpInlineOut, jsFiles.find((f) => /^app[.\-]/.test(f))!),
    ).text();
    expect(appJs).toContain("hello");
  });

  test("basename appears in HTML → separate module output", async () => {
    // lib.ts is referenced from HTML → should stay as separate module
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body>
        <script type="module" src="app.ts"></script>
        <script type="module" src="lib.ts"></script>
      </body></html>`,
    );
    await Bun.write(
      join(tmpInlineSrc, "app.ts"),
      `import { util } from "./lib.ts";\nconsole.log(util());`,
    );
    await Bun.write(
      join(tmpInlineSrc, "lib.ts"),
      `export function util() { return "lib"; }`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    expect(jsFiles.some((f) => /^app[.\-]/.test(f))).toBe(true);
    expect(jsFiles.some((f) => /^lib[.\-]/.test(f))).toBe(true);
  });

  test("basename in inline script import → separate module", async () => {
    // shared.ts appears in HTML inline import → separate module
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body>
        <script type="module" src="entry.ts"></script>
        <script type="module">
          import { val } from "./shared.ts";
          console.log(val);
        </script>
      </body></html>`,
    );
    await Bun.write(
      join(tmpInlineSrc, "entry.ts"),
      `import { val } from "./shared.ts";\nconsole.log(val);`,
    );
    await Bun.write(
      join(tmpInlineSrc, "shared.ts"),
      `export const val = 42;`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    expect(jsFiles.some((f) => /^shared[.\-]/.test(f))).toBe(true);
  });

  test("?? suffix forces inline into importer, but keeps independent module if HTML references it", async () => {
    // force.ts is directly referenced in HTML <script src> → independent module output
    // AND imported with ?? in app.ts → code also inlined into app.js
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body>
        <script type="module" src="app.ts"></script>
        <script type="module" src="force.ts"></script>
      </body></html>`,
    );
    await Bun.write(
      join(tmpInlineSrc, "app.ts"),
      `import { x } from "./force.ts??";\nconsole.log(x);`,
    );
    await Bun.write(
      join(tmpInlineSrc, "force.ts"),
      `export const x = "forced";`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    // force.ts is in HTML <script src> → still has independent output
    expect(jsFiles.some((f) => /^app[.\-]/.test(f))).toBe(true);
    expect(jsFiles.some((f) => /^force[.\-]/.test(f))).toBe(true);

    // But app.js should also contain the inlined code from force.ts
    const appJs = await Bun.file(
      join(tmpInlineOut, jsFiles.find((f) => /^app[.\-]/.test(f))!),
    ).text();
    expect(appJs).toContain("forced");
  });

  test("?? suffix forces inline, no independent output if not in HTML", async () => {
    // force.ts is NOT referenced in HTML, only via ?? → inlined, no separate file
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body>
        <script type="module" src="app.ts"></script>
      </body></html>`,
    );
    await Bun.write(
      join(tmpInlineSrc, "app.ts"),
      `import { x } from "./force.ts??";\nconsole.log(x);`,
    );
    await Bun.write(
      join(tmpInlineSrc, "force.ts"),
      `export const x = "forced";`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    expect(jsFiles.some((f) => /^app[.\-]/.test(f))).toBe(true);
    expect(jsFiles.some((f) => /^force[.\-]/.test(f))).toBe(false);

    const appJs = await Bun.file(
      join(tmpInlineOut, jsFiles.find((f) => /^app[.\-]/.test(f))!),
    ).text();
    expect(appJs).toContain("forced");
  });

  test("deep dependency chain — transitive auto-inline", async () => {
    // a.ts → b.ts → c.ts, only a.ts in HTML; b.ts and c.ts should be inlined
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body><script type="module" src="a.ts"></script></body></html>`,
    );
    await Bun.write(
      join(tmpInlineSrc, "a.ts"),
      `import { b } from "./b.ts";\nconsole.log(b);`,
    );
    await Bun.write(
      join(tmpInlineSrc, "b.ts"),
      `import { c } from "./c.ts";\nexport const b = c + 1;`,
    );
    await Bun.write(
      join(tmpInlineSrc, "c.ts"),
      `export const c = 100;`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    expect(jsFiles.some((f) => /^a[.\-]/.test(f))).toBe(true);
    expect(jsFiles.some((f) => /^b[.\-]/.test(f))).toBe(false);
    expect(jsFiles.some((f) => /^c[.\-]/.test(f))).toBe(false);

    // All code should be bundled into a's output
    const aJs = await Bun.file(
      join(tmpInlineOut, jsFiles.find((f) => /^a[.\-]/.test(f))!),
    ).text();
    expect(aJs).toContain("100");
  });

  test("subdirectory helper is auto-inlined", async () => {
    // sub/util.ts only imported by app.ts, not in HTML → inlined
    await mkdir(join(tmpInlineSrc, "sub"), { recursive: true });
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body><script type="module" src="app.ts"></script></body></html>`,
    );
    await Bun.write(
      join(tmpInlineSrc, "app.ts"),
      `import { add } from "./sub/util.ts";\nconsole.log(add(1, 2));`,
    );
    await Bun.write(
      join(tmpInlineSrc, "sub", "util.ts"),
      `export function add(a: number, b: number) { return a + b; }`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    expect(jsFiles.some((f) => /^app[.\-]/.test(f))).toBe(true);
    expect(jsFiles.some((f) => /util[.\-]/.test(f))).toBe(false);
  });
});

// 覆盖：动态加载场景（字符串字面量 "./a.js" 而非 import）下，
// a.ts 改动时下游 b.ts 的产物 hash 应该跟着变化、内部字符串引用应被
// 重写为新 hash 产物名，旧 a.[oldhash].js 应被清理。
describe("buildProject — dynamic-script reference", () => {
  beforeEach(async () => {
    await rm(tmpInlineSrc, { recursive: true, force: true });
    await rm(tmpInlineOut, { recursive: true, force: true });
    await mkdir(tmpInlineSrc, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpInlineSrc, { recursive: true, force: true });
    await rm(tmpInlineOut, { recursive: true, force: true });
  });

  test("string-literal './a.js' triggers hash update on downstream when a.ts changes", async () => {
    // b.ts 通过 createElement('script') 动态加载 a.js（编译后路径），
    // 不通过 import —— 这是常见的运行时插件加载/code-splitting 模式。
    await Bun.write(
      join(tmpInlineSrc, "a.ts"),
      `export const tag = "A_V1";`,
    );
    await Bun.write(
      join(tmpInlineSrc, "b.ts"),
      `const s = document.createElement("script");\n` +
        `s.src = "./a.js";\n` +
        `document.head.appendChild(s);`,
    );
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body>` +
        `<script type="module" src="./a.ts"></script>` +
        `<script type="module" src="./b.ts"></script>` +
        `</body></html>`,
    );

    // 第 1 次 build
    await buildProject(tmpInlineSrc, tmpInlineOut);
    const files1 = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    const a1 = files1.find((f) => /^a[.\-][0-9a-z]+\.js$/.test(f));
    const b1 = files1.find((f) => /^b[.\-][0-9a-z]+\.js$/.test(f));
    expect(a1).toBeDefined();
    expect(b1).toBeDefined();
    // b1 内部的字符串路径应已重写为带 hash 的 a 产物名
    const b1Code = await Bun.file(join(tmpInlineOut, b1!)).text();
    expect(b1Code).toContain(a1!);
    expect(b1Code).not.toMatch(/["']\.\/a\.js["']/);

    // 修改 a.ts，第 2 次 build
    await Bun.write(
      join(tmpInlineSrc, "a.ts"),
      `export const tag = "A_V2_with_very_different_content_for_hash";`,
    );
    await buildProject(tmpInlineSrc, tmpInlineOut);
    const files2 = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    const a2 = files2.find((f) => /^a[.\-][0-9a-z]+\.js$/.test(f));
    const b2 = files2.find((f) => /^b[.\-][0-9a-z]+\.js$/.test(f));
    expect(a2).toBeDefined();
    expect(b2).toBeDefined();

    // a 产物 hash 必须变化
    expect(a2).not.toBe(a1);
    // b 产物 hash 也必须变化（动态依赖纳入了内容指纹）
    expect(b2).not.toBe(b1);
    // b2 内部应指向新的 a2，而不是旧的 a1
    const b2Code = await Bun.file(join(tmpInlineOut, b2!)).text();
    expect(b2Code).toContain(a2!);
    expect(b2Code).not.toContain(a1!);

    // 旧 a.[oldhash].js 应已被孤儿清理
    const aFiles = files2.filter((f) => /^a[.\-][0-9a-z]+\.js$/.test(f));
    expect(aFiles).toHaveLength(1);
    expect(aFiles[0]).toBe(a2);
  });

  test("supports both './a.js' and './a.ts' string-literal styles", async () => {
    await Bun.write(
      join(tmpInlineSrc, "a.ts"),
      `export const v = 1;`,
    );
    // b.ts 既有 .js 也有 .ts 形式的字面量引用
    await Bun.write(
      join(tmpInlineSrc, "b.ts"),
      `const s1 = "./a.js";\nconst s2 = "./a.ts";\nconsole.log(s1, s2);`,
    );
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body>` +
        `<script type="module" src="./a.ts"></script>` +
        `<script type="module" src="./b.ts"></script>` +
        `</body></html>`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);
    const files = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    const a = files.find((f) => /^a[.\-][0-9a-z]+\.js$/.test(f))!;
    const b = files.find((f) => /^b[.\-][0-9a-z]+\.js$/.test(f))!;
    const bCode = await Bun.file(join(tmpInlineOut, b)).text();
    // 两种形式都应被重写为带 hash 的产物名
    expect(bCode).not.toMatch(/["']\.\/a\.js["']/);
    expect(bCode).not.toMatch(/["']\.\/a\.ts["']/);
    // 至少出现两次新产物名（s1、s2 都应替换）
    const occ = bCode.split(a).length - 1;
    expect(occ).toBeGreaterThanOrEqual(2);
  });
});
