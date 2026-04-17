import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { processHtml } from "./html.ts";

const tmpDir = join(import.meta.dir, "__test_html_tmp__");

describe("processHtml", () => {
  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("minifies HTML (removes whitespace and comments)", async () => {
    const htmlFile = join(tmpDir, "basic.html");
    await writeFile(
      htmlFile,
      `<html>
  <head>
    <title>Test</title>
  </head>
  <!-- comment -->
  <body>
    <h1>Hello</h1>
  </body>
</html>`,
    );

    const result = await processHtml(htmlFile);
    expect(result).not.toContain("<!-- comment -->");
    expect(result).toContain("<h1>Hello</h1>");
    expect(result).toContain("<title>Test</title>");
    // whitespace should be collapsed
    expect(result.length).toBeLessThan(150);
  });

  test("minifies inline <style> content", async () => {
    const htmlFile = join(tmpDir, "styled.html");
    await writeFile(
      htmlFile,
      `<html>
<head>
  <style>
    body {
      color: red;
      margin: 0;
    }
  </style>
</head>
<body>Hello</body>
</html>`,
    );

    const result = await processHtml(htmlFile);
    expect(result).toContain("<style>body{color:red;margin:0}</style>");
  });

  test("handles multiple <style> blocks", async () => {
    const htmlFile = join(tmpDir, "multi-style.html");
    await writeFile(
      htmlFile,
      `<html>
<head>
  <style>h1 { color: blue; }</style>
  <style>h2 { color: green; }</style>
</head>
<body></body>
</html>`,
    );

    const result = await processHtml(htmlFile);
    expect(result).toContain("<style>h1{color:#00f}</style>");
    expect(result).toContain("<style>h2{color:green}</style>");
  });

  test("preserves script tags", async () => {
    const htmlFile = join(tmpDir, "script.html");
    await writeFile(
      htmlFile,
      `<html>
<body>
  <script type="module" src="main.ts"></script>
</body>
</html>`,
    );

    const result = await processHtml(htmlFile);
    expect(result).toContain('src="main.ts"');
    expect(result).toContain('type="module"');
  });

  test("handles empty HTML", async () => {
    const htmlFile = join(tmpDir, "empty.html");
    await writeFile(htmlFile, "<html><body></body></html>");

    const result = await processHtml(htmlFile);
    expect(result).toBe("<html><body></body></html>");
  });
});
