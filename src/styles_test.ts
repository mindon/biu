import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    await writeFile(cssFile, "h1 {\n  color: red;\n  font-size: 16px;\n}\n");

    try {
      const result = await compileStyle(cssFile);
      expect(result).toBe("h1{color:red;font-size:16px}");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("compiles and minifies SCSS file", async () => {
    await mkdir(tmpDir, { recursive: true });
    const scssFile = join(tmpDir, "test.scss");
    await writeFile(
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
    await writeFile(
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
    await writeFile(cssFile, "body { margin: 0; }");

    try {
      const map = await processStyleFiles([cssFile], srcDir, outDir);

      expect(map.size).toBe(1);
      expect(map.has(cssFile)).toBe(true);

      const outputPath = map.get(cssFile)!;
      expect(outputPath).toMatch(/main-[0-9a-f]{8}\.css$/);

      const content = await readFile(outputPath, "utf8");
      expect(content).toBe("body{margin:0}");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("processes SCSS files with .css output extension", async () => {
    await mkdir(srcDir, { recursive: true });
    const scssFile = join(srcDir, "theme.scss");
    await writeFile(
      scssFile,
      "$bg: #fff;\nbody { background: $bg; }\n",
    );

    try {
      const map = await processStyleFiles([scssFile], srcDir, outDir);

      expect(map.size).toBe(1);
      const outputPath = map.get(scssFile)!;
      expect(outputPath).toMatch(/theme-[0-9a-f]{8}\.css$/);

      const content = await readFile(outputPath, "utf8");
      expect(content).toBe("body{background:#fff}");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("preserves subdirectory structure", async () => {
    const subDir = join(srcDir, "components");
    await mkdir(subDir, { recursive: true });
    const cssFile = join(subDir, "btn.css");
    await writeFile(cssFile, ".btn { display: inline-block; }");

    try {
      const map = await processStyleFiles([cssFile], srcDir, outDir);
      const outputPath = map.get(cssFile)!;
      expect(outputPath).toContain(join(outDir, "components"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty map for no input", async () => {
    const map = await processStyleFiles([], srcDir, outDir);
    expect(map.size).toBe(0);
  });
});
