import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { contentHash, scan, stripJsComments } from "./utils.ts";

describe("contentHash", () => {
  test("returns 8-char hex string by default", () => {
    const hash = contentHash("hello world");
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  test("custom length parameter", () => {
    const hash = contentHash("hello world", 16);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("same content produces same hash", () => {
    const a = contentHash("test content");
    const b = contentHash("test content");
    expect(a).toBe(b);
  });

  test("different content produces different hash", () => {
    const a = contentHash("content A");
    const b = contentHash("content B");
    expect(a).not.toBe(b);
  });

  test("works with Buffer input", () => {
    const buf = Buffer.from("binary content");
    const hash = contentHash(buf);
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  test("Buffer and string of same content produce same hash", () => {
    const str = "same content";
    const a = contentHash(str);
    const b = contentHash(Buffer.from(str));
    expect(a).toBe(b);
  });
});

describe("scan", () => {
  const testDir = join(import.meta.dir, "__test_scan_tmp__");

  test("recursively lists all files", async () => {
    // Setup temp directory
    await mkdir(join(testDir, "sub", "deep"), { recursive: true });
    await Bun.write(join(testDir, "a.txt"), "a");
    await Bun.write(join(testDir, "b.ts"), "b");
    await Bun.write(join(testDir, "sub", "c.js"), "c");
    await Bun.write(join(testDir, "sub", "deep", "d.html"), "d");

    try {
      const files = await scan(testDir);
      expect(files).toHaveLength(4);
      expect(files).toContain(join(testDir, "a.txt"));
      expect(files).toContain(join(testDir, "b.ts"));
      expect(files).toContain(join(testDir, "sub", "c.js"));
      expect(files).toContain(join(testDir, "sub", "deep", "d.html"));
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("returns empty array for empty directory", async () => {
    await mkdir(testDir, { recursive: true });
    try {
      const files = await scan(testDir);
      expect(files).toHaveLength(0);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

describe("stripJsComments", () => {
  test("removes line comments", () => {
    const out = stripJsComments(`const a = 1; // trailing\nconst b = 2;`);
    expect(out).toBe(`const a = 1; \nconst b = 2;`);
  });

  test("removes block comments while preserving newlines", () => {
    const out = stripJsComments(`a;\n/* multi\nline\ncomment */\nb;`);
    expect(out).toBe(`a;\n\n\n\nb;`);
  });

  test("does not strip // inside strings", () => {
    const out = stripJsComments(`const u = "https://example.com/path";`);
    expect(out).toBe(`const u = "https://example.com/path";`);
  });

  test("does not strip /* inside strings", () => {
    const out = stripJsComments(`const x = '/* not a comment */';`);
    expect(out).toBe(`const x = '/* not a comment */';`);
  });

  test("preserves template literals", () => {
    const out = stripJsComments("const t = `a // not comment ${1+2}`;");
    expect(out).toBe("const t = `a // not comment ${1+2}`;");
  });

  test("removes commented-out import statement", () => {
    // Reproduces the false-positive: `// import "/not-exists.js";`
    // must not leave the string literal in the output.
    const out = stripJsComments(
      `import "/simple.js";\n// import "/not-exists.js";\nconst x = 1;`,
    );
    expect(out).toContain(`import "/simple.js";`);
    expect(out).not.toContain("not-exists.js");
  });

  test("handles escaped quotes in strings", () => {
    const out = stripJsComments(`const s = "a\\"// not";`);
    expect(out).toBe(`const s = "a\\"// not";`);
  });
});
