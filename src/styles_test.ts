import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { cleanCss, compileStyle, processStyleFiles } from "./styles.ts";

const tmpDir = join(import.meta.dir, "__test_styles_tmp__");

describe("cleanCss", () => {
  test("instance exists and minifies CSS", () => {
    const result = cleanCss.minify("body { color: red; }");
    expect(result.styles).toBe("body{color:red}");
  });
});

describe("compileStyle", () => {
  test("minifies plain CSS file", async () => {
    await mkdir(tmpDir, { recursive: true });
    const cssFile = join(tmpDir, "test.css");
    await Bun.write(cssFile, "h1 {\n  color: red;\n  font-size: 16px;\n}\n");

    try {
      const result = await compileStyle(cssFile);
      expect(result).toBe("h1{color:red;font-size:16px}");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("preserves SVG data URI filters without scanning their payload", async () => {
    await mkdir(tmpDir, { recursive: true });
    const cssFile = join(tmpDir, "svg-data-uri.css");
    await Bun.write(
      cssFile,
      `h3 { background-image: url("data:image/svg+xml,%3Csvg%3E%3Cfilter id='n'/%3E%3Crect filter='url(%23n)'/%3E%3C/svg%3E"); }`,
    );

    try {
      const result = await compileStyle(cssFile);
      expect(result).toContain("data:image/svg+xml");
      expect(result).toContain("url(%23n)");
      expect(result).not.toContain("https://biu.invalid/url/");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("compiles and minifies SCSS file", async () => {
    await mkdir(tmpDir, { recursive: true });
    const scssFile = join(tmpDir, "test.scss");
    await Bun.write(
      scssFile,
      "$color: #333;\nbody {\n  color: $color;\n}\n",
    );

    try {
      const result = await compileStyle(scssFile);
      expect(result).toBe("body{color:#333}");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("handles SCSS nesting", async () => {
    await mkdir(tmpDir, { recursive: true });
    const scssFile = join(tmpDir, "nested.scss");
    await Bun.write(
      scssFile,
      ".parent {\n  .child {\n    color: blue;\n  }\n}\n",
    );

    try {
      const result = await compileStyle(scssFile);
      expect(result).toContain(".parent .child");
      expect(result).toContain("color:#00f"); // CleanCSS minifies "blue" to "#00f"
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("processStyleFiles", () => {
  const srcDir = join(tmpDir, "src");
  const outDir = join(tmpDir, "out");

  test("processes CSS files with content hash in filename", async () => {
    await mkdir(srcDir, { recursive: true });
    const cssFile = join(srcDir, "main.css");
    await Bun.write(cssFile, "body { margin: 0; }");

    try {
      const { map, wrote } = await processStyleFiles([cssFile], srcDir, outDir);

      expect(map.size).toBe(1);
      expect(map.has(cssFile)).toBe(true);
      expect(wrote).toBe(1);

      const outputPath = map.get(cssFile)!;
      expect(outputPath).toMatch(/main-[0-9a-f]{8}\.css$/);

      const content = await Bun.file(outputPath).text();
      expect(content).toBe("body{margin:0}");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("processes SCSS files with .css output extension", async () => {
    await mkdir(srcDir, { recursive: true });
    const scssFile = join(srcDir, "theme.scss");
    await Bun.write(
      scssFile,
      "$bg: #fff;\nbody { background: $bg; }\n",
    );

    try {
      const { map, wrote } = await processStyleFiles(
        [scssFile],
        srcDir,
        outDir,
      );

      expect(map.size).toBe(1);
      expect(wrote).toBe(1);
      const outputPath = map.get(scssFile)!;
      expect(outputPath).toMatch(/theme-[0-9a-f]{8}\.css$/);

      const content = await Bun.file(outputPath).text();
      expect(content).toBe("body{background:#fff}");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("preserves subdirectory structure", async () => {
    const subDir = join(srcDir, "components");
    await mkdir(subDir, { recursive: true });
    const cssFile = join(subDir, "btn.css");
    await Bun.write(cssFile, ".btn { display: inline-block; }");

    try {
      const { map } = await processStyleFiles([cssFile], srcDir, outDir);
      const outputPath = map.get(cssFile)!;
      expect(outputPath).toContain(join(outDir, "components"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty map for no input", async () => {
    const { map, wrote } = await processStyleFiles([], srcDir, outDir);
    expect(map.size).toBe(0);
    expect(wrote).toBe(0);
  });
});

describe("CSS @import preservation", () => {
  const base = join(tmpDir, "scss_import");
  const srcDir = join(base, "src");
  const outDir = join(base, "out");

  test("preserves relative @import ./a.css in SCSS output (no resolve error)", async () => {
    await mkdir(srcDir, { recursive: true });
    // 注意：a.css 无需真实存在，@import 应原样保留、不做文件解析
    await Bun.write(
      join(srcDir, "main.scss"),
      '@import "./a.css";\nbody { margin: 0; }\n',
    );

    try {
      const result = await compileStyle(join(srcDir, "main.scss"));
      expect(result).toContain('@import "./a.css"');
      expect(result).toContain("margin:0");
      // 不应内联，也不应因找不到文件而报错或丢弃
      expect(result).not.toContain("color");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("preserves absolute @import /b.css in SCSS output", async () => {
    await mkdir(srcDir, { recursive: true });
    await Bun.write(
      join(srcDir, "main.scss"),
      '@import "/b.css";\np { font-size: 14px; }\n',
    );

    try {
      const result = await compileStyle(join(srcDir, "main.scss"));
      expect(result).toContain('@import "/b.css"');
      expect(result).toContain("font-size:14px");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("preserves @import in plain CSS files", async () => {
    await mkdir(srcDir, { recursive: true });
    await Bun.write(
      join(srcDir, "app.css"),
      '@import "./reset.css";\ndiv { display: flex; }\n',
    );

    try {
      const result = await compileStyle(join(srcDir, "app.css"));
      expect(result).toContain('@import "./reset.css"');
      expect(result).toContain("display:flex");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("preserves @import url(...) form", async () => {
    await mkdir(srcDir, { recursive: true });
    await Bun.write(
      join(srcDir, "u.css"),
      '@import url("./c.css");\nspan { color: red; }\n',
    );

    try {
      const result = await compileStyle(join(srcDir, "u.css"));
      expect(result).toContain('@import url("./c.css")');
      expect(result).toContain("color:red");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("processStyleFiles keeps @import in output", async () => {
    await mkdir(srcDir, { recursive: true });
    await Bun.write(
      join(srcDir, "theme.scss"),
      '@import "/vars.css";\nbody { color: var(--c); }\n',
    );

    try {
      const { map } = await processStyleFiles(
        [join(srcDir, "theme.scss")],
        srcDir,
        outDir,
      );
      const outputPath = map.get(join(srcDir, "theme.scss"))!;
      const content = await Bun.file(outputPath).text();
      expect(content).toContain('@import "/vars.css"');
      expect(content).toContain("color:var(--c)");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
