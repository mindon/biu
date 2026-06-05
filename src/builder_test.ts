import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { basename, join, resolve } from "node:path";
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

  test("inline <script type=module> imports keep relative prefix (./ or ../)", async () => {
    try {
      await buildProject(demoSrc, tmpOut);

      const worldHtml = await Bun.file(join(tmpOut, "hey", "world.html"))
        .text();
      // ES module specifiers must start with "/", "./" or "../" — a bare
      // "world2.<hash>.js" would throw `Failed to resolve module specifier`.
      // 当前 fixture 中 world.html 引用 "../cool/world2.ts"，期望产物保持
      // "../cool/world2.<hash>.js"（保留相对前缀）。
      expect(worldHtml).toMatch(
        /\bfrom\s*["'](?:\.\/|\.\.\/)[^"']*world2[.\-][0-9a-z]+\.js["']/,
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

  test("string-literal worker refs in inlined transit modules are rewritten with original path shape", async () => {
    // 场景：main.ts → import "./hey/auto-inline.ts"（中转，被内联）
    //       auto-inline.ts → new Worker("./world2.ts")（按它自己的目录写的相对路径）
    // 期望：world2.ts 单独构建为产物，main 产物里字面量改写为
    //       "./world2.<hash>.js"（保持原层级形状），而不是
    //       "./hey/world2.<hash>.js"（错误地以 main 目录为基准）。
    await mkdir(join(tmpInlineSrc, "hey"), { recursive: true });
    await Bun.write(
      join(tmpInlineSrc, "hey", "world2.ts"),
      `export const v = 2;`,
    );
    await Bun.write(
      join(tmpInlineSrc, "hey", "auto-inline.ts"),
      [
        `export const tag = "auto";`,
        `const base = () => "/hey/";`,
        `const w = new Worker(base() + "./world2.ts");`,
        `w.onmessage = (e) => console.log(e.data);`,
      ].join("\n"),
    );
    await Bun.write(
      join(tmpInlineSrc, "main.ts"),
      [
        `import "./hey/auto-inline.ts";`,
        `console.log("main");`,
      ].join("\n"),
    );
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body><script type="module" src="./main.ts"></script></body></html>`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);

    const files = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    // world2 必须独立产物
    const world2 = files.find((f) => /^hey\/world2[.\-][0-9a-z]+\.js$/.test(f));
    expect(world2).toBeDefined();

    // auto-inline 不应单独产物（它通过裸 import 被内联）
    expect(files.some((f) => /auto-inline/.test(f))).toBe(false);

    // main 产物里字面量必须改写为 "./world2.<hash>.js"（与原字面量同层级），
    // 不可改成 "./hey/world2.<hash>.js"（破坏了 base() + "..." 的拼接语义）。
    const main = files.find((f) => /^main[.\-][0-9a-z]+\.js$/.test(f))!;
    const code = await Bun.file(join(tmpInlineOut, main)).text();
    const world2Base = world2!.replace(/^hey\//, "");
    expect(code).toContain(`"./${world2Base}"`);
    expect(code).not.toContain(`"./hey/${world2Base}"`);
    expect(code).not.toMatch(/["']\.\/world2\.ts["']/); // 裸 .ts 必须消失
  });

  test("extensionless import propagates transitive deps into entry hash", async () => {
    // 场景（demo-project 里复现的真实问题）：
    //   main.ts → import "./hey/auto-inline";  (无扩展名！)
    //   auto-inline.ts → import "../cool/mid.ts";   (cool/mid.ts 是独立 module)
    //   cool/mid.ts → import { v } from "./world2.ts";
    //
    // 之前 BUG：scanner 的 import 正则强制要求 `.ts`/`.js` 后缀，
    //   所以 `import "./hey/auto-inline"` 完全不被识别 →
    //   main 的传递依赖图遗漏了 auto-inline / mid / world2 →
    //   mid 改动 → main 内容指纹不变 → main 文件名 hash 不变 →
    //   浏览器 / CDN 命中旧版 main.<oldhash>.js（其内部 import 路径已被
    //   补丁式更新到新 mid hash，但文件名没变 → 缓存灾难）。
    //
    // 期望：mid 改动 → main 文件名 hash 必须跟着变。
    await mkdir(join(tmpInlineSrc, "hey"), { recursive: true });
    await mkdir(join(tmpInlineSrc, "cool"), { recursive: true });
    await Bun.write(
      join(tmpInlineSrc, "cool", "world2.ts"),
      `export const v = 1;\nconsole.log("world2");`,
    );
    await Bun.write(
      join(tmpInlineSrc, "cool", "mid.ts"),
      `import { v } from "./world2.ts";\nconsole.log("mid", v);`,
    );
    await Bun.write(
      join(tmpInlineSrc, "hey", "auto-inline.ts"),
      `import "../cool/mid.ts";\nexport const tag = "auto";`,
    );
    await Bun.write(
      join(tmpInlineSrc, "main.ts"),
      [
        // 关键：无扩展名 import
        `import "./hey/auto-inline";`,
        `console.log("main");`,
      ].join("\n"),
    );
    // 让 mid.ts / world2.ts 成为独立 module（basename 命中某个 HTML）。
    // 测试要复现的核心 bug 只在"传递依赖中包含独立 module"时才出现。
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body>` +
        `<script type="module" src="./main.ts"></script>` +
        `<script type="module" src="./cool/mid.ts"></script>` +
        `<script type="module" src="./cool/world2.ts"></script>` +
        `</body></html>`,
    );

    // 第一次构建
    await buildProject(tmpInlineSrc, tmpInlineOut);
    let files = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    const main1 = files.find((f) => /^main[.\-][0-9a-z]+\.js$/.test(f))!;
    const mid1 = files.find((f) => /^cool\/mid[.\-][0-9a-z]+\.js$/.test(f))!;
    const world2_1 = files.find((f) =>
      /^cool\/world2[.\-][0-9a-z]+\.js$/.test(f)
    )!;
    expect(main1).toBeDefined();
    expect(mid1).toBeDefined();
    expect(world2_1).toBeDefined();

    // main 产物里必须 import 真实的 mid hash 文件（而非裸 .ts 或裸 .js）
    let mainCode = await Bun.file(join(tmpInlineOut, main1)).text();
    expect(mainCode).toContain(basename(mid1));

    // 修改 world2.ts —— 触发传递更新
    await Bun.write(
      join(tmpInlineSrc, "cool", "world2.ts"),
      `export const v = 2;\nconsole.log("world2 v2");`,
    );

    // 第二次构建
    await buildProject(tmpInlineSrc, tmpInlineOut);
    files = await Array.fromAsync(new Bun.Glob("**/*.js").scan(tmpInlineOut));
    const main2 = files.find((f) => /^main[.\-][0-9a-z]+\.js$/.test(f))!;
    const mid2 = files.find((f) => /^cool\/mid[.\-][0-9a-z]+\.js$/.test(f))!;
    const world2_2 = files.find((f) =>
      /^cool\/world2[.\-][0-9a-z]+\.js$/.test(f)
    )!;

    // 三层 hash 必须全部变化 —— 这是修复的核心断言
    expect(world2_2).not.toBe(world2_1);
    expect(mid2).not.toBe(mid1);
    expect(main2).not.toBe(main1); // ← 修复前这里失败：main hash 不变

    // main 产物内部也要指向新 mid（既要文件名变，又要内容正确）
    mainCode = await Bun.file(join(tmpInlineOut, main2)).text();
    expect(mainCode).toContain(basename(mid2));
    expect(mainCode).not.toContain(basename(mid1));
  });

  test("root-absolute import (e.g. /simple.js) is kept external", async () => {
    // 场景：在 main.ts 中写 `import "/simple.js"`，语义上是\"部署根 web root\"
    // 引用（运行时由浏览器从静态目录加载）。
    // 之前 BUG：bun 默认把 `/` 起头的 specifier 当作\"文件系统绝对路径\"
    //   解析 → 报错 `Could not resolve: \"/simple.js\"`，整个构建失败。
    // 期望：构建成功，产物里原样保留 `import "/simple.js"`（external）。
    await Bun.write(
      join(tmpInlineSrc, "main.ts"),
      [
        `import "/simple.js";`,
        `import "/assets/icon.png";`,
        `console.log("main");`,
      ].join("\n"),
    );
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body><script type="module" src="./main.ts"></script></body></html>`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);
    const files = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    const main = files.find((f) => /^main[.\-][0-9a-z]+\.js$/.test(f))!;
    expect(main).toBeDefined();

    const code = await Bun.file(join(tmpInlineOut, main)).text();
    // 必须 external 原样保留（绝不能被解析为相对路径或被 bundle）
    expect(code).toContain(`"/simple.js"`);
    expect(code).toContain(`"/assets/icon.png"`);
    // 不应出现解析后的本地路径前缀
    expect(code).not.toMatch(/["']\.\/simple\.js["']/);
  });

  test("absolute / external URIs in string literals are left untouched", async () => {
    // 锁定语义：绝对 URI / 协议相对 URL / 根路径 / file:// 一律不参与改写
    // —— 它们指向外部资源或运行时由 dev server / CDN 解析的路径，构建期不应介入。
    await Bun.write(
      join(tmpInlineSrc, "a.ts"),
      `export const v = 1;`,
    );
    await Bun.write(
      join(tmpInlineSrc, "main.ts"),
      [
        `import "./a.ts";`,
        // 各种绝对 / 外部形态：构建后应原样保留
        `const w1 = new Worker("https://cdn.example.com/worker.js");`,
        `const w2 = new Worker("http://example.com/w.ts");`,
        `const w3 = new Worker("//cdn.example.com/proto-rel.js");`,
        `const w4 = new Worker("/abs/worker.ts");`,
        `const w5 = new Worker("file:///tmp/local.js");`,
        `const p1 = import("https://cdn.example.com/mod.js");`,
        `console.log(w1, w2, w3, w4, w5, p1);`,
      ].join("\n"),
    );
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body><script type="module" src="./main.ts"></script></body></html>`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut);
    const files = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    const main = files.find((f) => /^main[.\-][0-9a-z]+\.js$/.test(f))!;
    const code = await Bun.file(join(tmpInlineOut, main)).text();

    // 全部绝对 URI 字面量必须原样保留
    expect(code).toContain("https://cdn.example.com/worker.js");
    expect(code).toContain("http://example.com/w.ts");
    expect(code).toContain("//cdn.example.com/proto-rel.js");
    expect(code).toContain("/abs/worker.ts");
    expect(code).toContain("file:///tmp/local.js");
    expect(code).toContain("https://cdn.example.com/mod.js");

    // 不应把外部 .ts 当成本地源文件构建出对应产物
    expect(files.some((f) => /^w[.\-][0-9a-z]+\.js$/.test(f))).toBe(false);
    expect(files.some((f) => /^worker[.\-][0-9a-z]+\.js$/.test(f))).toBe(false);
  });

  test(
    "circular module deps still inject __biu_upstream__ seed (src-hash fallback)",
    async () => {
      // 复现 BUG：当两个 module entry 互相 import（如 worker ↔ runner），
      // 拓扑排序失败 → sortedModules 回退到原顺序 → 第一个被构建的 entry
      // 看不到任何上游产物（moduleOutputs.get(dep) === undefined）。
      // 之前的实现：seedParts 为空 → entryHashSeed = undefined →
      //   产物里没有 `__biu_upstream__` 注释 → 上游变化无法触发该 entry
      //   产物 hash 变更 → 浏览器/CDN 缓存失效失灵。
      // 修复：当上游产物名缺失时，回退到使用上游 src 文件的 16 位内容 hash。
      await Bun.write(
        join(tmpInlineSrc, "runner.ts"),
        // 通过字符串字面量引用 worker.ts → biu 把 worker.ts 升级为 module
        `const w = new Worker("./worker.ts");\nexport const r = 1;`,
      );
      await Bun.write(
        join(tmpInlineSrc, "worker.ts"),
        // 通过字符串字面量回引 runner.ts → 形成 module 间循环依赖
        `const r = "./runner.ts";\nexport const w = 1;\nconsole.log(r);`,
      );
      await Bun.write(
        join(tmpInlineSrc, "main.ts"),
        // main 同时依赖 runner 和 worker，是 entry hash 应跟随上游变化的下游
        `import "./runner";\nimport "./worker";`,
      );
      await Bun.write(
        join(tmpInlineSrc, "index.html"),
        `<html><body>` +
          `<script type="module" src="./main.ts"></script>` +
          `<script type="module" src="./runner.ts"></script>` +
          `<script type="module" src="./worker.ts"></script>` +
          `</body></html>`,
      );

      await buildProject(tmpInlineSrc, tmpInlineOut);
      const files1 = await Array.fromAsync(
        new Bun.Glob("**/*.js").scan(tmpInlineOut),
      );
      const main1 = files1.find((f) => /^main[.\-][0-9a-z]+\.js$/.test(f))!;
      expect(main1).toBeDefined();

      const code1 = await Bun.file(join(tmpInlineOut, main1)).text();
      // 必须出现 seed 注释；至少包含一个上游 basename（产物名 OR src 名）
      expect(code1).toMatch(/__biu_upstream__:m:/);
      // 修改 worker.ts 源码 → seed 应变 → main 产物 hash 应变
      await Bun.write(
        join(tmpInlineSrc, "worker.ts"),
        `const r = "./runner.ts";\n` +
          `export const w = 99;\n` +
          `console.log(r, "VERY_DIFFERENT_CONTENT_FOR_HASH_CHANGE");`,
      );
      await buildProject(tmpInlineSrc, tmpInlineOut);
      const files2 = await Array.fromAsync(
        new Bun.Glob("**/*.js").scan(tmpInlineOut),
      );
      const main2 = files2.find((f) => /^main[.\-][0-9a-z]+\.js$/.test(f))!;
      expect(main2).toBeDefined();

      // 关键断言：上游变 → main 产物 hash 必变
      expect(main2).not.toBe(main1);
      const code2 = await Bun.file(join(tmpInlineOut, main2)).text();
      expect(code2).toMatch(/__biu_upstream__:m:/);
      // seed 内容必须不同（hash 段变了）
      const seed1 = code1.match(/__biu_upstream__:[^\s*]+/)?.[0];
      const seed2 = code2.match(/__biu_upstream__:[^\s*]+/)?.[0];
      expect(seed1).toBeDefined();
      expect(seed2).toBeDefined();
      expect(seed2).not.toBe(seed1);
    },
  );
});

describe("buildProject — import maps", () => {
  beforeEach(async () => {
    await rm(tmpInlineSrc, { recursive: true, force: true });
    await rm(tmpInlineOut, { recursive: true, force: true });
    await mkdir(tmpInlineSrc, { recursive: true });
    await Bun.write(join(tmpInlineSrc, "package.json"), "{}");
  });

  afterAll(async () => {
    await rm(tmpInlineSrc, { recursive: true, force: true });
    await rm(tmpInlineOut, { recursive: true, force: true });
  });

  test("HTML importmap dependencies are not installed or bundled", async () => {
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><head>
        <script type="importmap">
        { "imports": { "cdn-pkg": "https://cdn.example.com/cdn-pkg.js" } }
        </script>
      </head><body><script type="module" src="./app.ts"></script></body></html>`,
    );
    await Bun.write(
      join(tmpInlineSrc, "app.ts"),
      `import { value } from "cdn-pkg";\nconsole.log(value);`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut, {
      kind: "txt",
      file: "deps.txt",
    });

    expect(existsSync(join(tmpInlineSrc, "deps.txt"))).toBe(false);
    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    const app = jsFiles.find((f) => /^app[.\-][0-9a-z]+\.js$/.test(f))!;
    const code = await Bun.file(join(tmpInlineOut, app)).text();
    expect(code).toContain("cdn-pkg");
    expect(code).toMatch(/from\s*["']cdn-pkg["']/);
  });

  test("dynamic importmap dependencies are not installed or bundled", async () => {
    await Bun.write(
      join(tmpInlineSrc, "index.html"),
      `<html><body>
        <script type="module" src="./importmap.ts"></script>
        <script type="module" src="./app.ts"></script>
      </body></html>`,
    );
    await Bun.write(
      join(tmpInlineSrc, "importmap.ts"),
      `const s = document.createElement("script");\n` +
        `s.type = "importmap";\n` +
        `s.textContent = JSON.stringify({ imports: { "dyn-pkg/": "https://cdn.example.com/dyn/" } });\n` +
        `document.head.appendChild(s);`,
    );
    await Bun.write(
      join(tmpInlineSrc, "app.ts"),
      `import { value } from "dyn-pkg/sub";\nconsole.log(value);`,
    );

    await buildProject(tmpInlineSrc, tmpInlineOut, {
      kind: "txt",
      file: "deps.txt",
    });

    expect(existsSync(join(tmpInlineSrc, "deps.txt"))).toBe(false);
    const jsFiles = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan(tmpInlineOut),
    );
    const app = jsFiles.find((f) => /^app[.\-][0-9a-z]+\.js$/.test(f))!;
    const code = await Bun.file(join(tmpInlineOut, app)).text();
    expect(code).toContain("dyn-pkg/sub");
    expect(code).toMatch(/from\s*["']dyn-pkg\/sub["']/);
  });
});
