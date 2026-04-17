import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { contentHash, scan } from "./utils.ts";

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
    await writeFile(join(testDir, "a.txt"), "a");
    await writeFile(join(testDir, "b.ts"), "b");
    await writeFile(join(testDir, "sub", "c.js"), "c");
    await writeFile(join(testDir, "sub", "deep", "d.html"), "d");

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
