import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { copyStaticDir, processAssetFiles } from "./assets.ts";

const tmpDir = join(import.meta.dir, "__test_assets_tmp__");

describe("processAssetFiles", () => {
  const srcDir = join(tmpDir, "src");
  const outDir = join(tmpDir, "out");

  test("copies asset with content hash in filename", async () => {
    await mkdir(join(srcDir, "img"), { recursive: true });
    const pngFile = join(srcDir, "img", "logo.png");
    await writeFile(pngFile, "fake-png-content");

    try {
      const map = await processAssetFiles([pngFile], srcDir, outDir);

      expect(map.size).toBe(1);
      expect(map.has(pngFile)).toBe(true);

      const outputPath = map.get(pngFile)!;
      expect(outputPath).toMatch(/logo-[0-9a-f]{8}\.png$/);
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("favicon.ico keeps original name without hash", async () => {
    await mkdir(srcDir, { recursive: true });
    const faviconFile = join(srcDir, "favicon.ico");
    await writeFile(faviconFile, "fake-ico-content");

    try {
      const map = await processAssetFiles([faviconFile], srcDir, outDir);

      const outputPath = map.get(faviconFile)!;
      expect(outputPath).toMatch(/favicon\.ico$/);
      expect(outputPath).not.toMatch(/-[0-9a-f]{8}\./);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("preserves subdirectory structure in output", async () => {
    await mkdir(join(srcDir, "assets", "fonts"), { recursive: true });
    const fontFile = join(srcDir, "assets", "fonts", "mono.woff2");
    await writeFile(fontFile, "fake-font-data");

    try {
      const map = await processAssetFiles([fontFile], srcDir, outDir);
      const outputPath = map.get(fontFile)!;
      expect(outputPath).toContain(join(outDir, "assets", "fonts"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("same content produces same hash", async () => {
    await mkdir(srcDir, { recursive: true });
    const fileA = join(srcDir, "a.txt");
    const fileB = join(srcDir, "b.txt");
    await writeFile(fileA, "identical");
    await writeFile(fileB, "identical");

    try {
      const map = await processAssetFiles([fileA, fileB], srcDir, outDir);
      const hashA = map.get(fileA)!.match(/-([0-9a-f]{8})\./)?.[1];
      const hashB = map.get(fileB)!.match(/-([0-9a-f]{8})\./)?.[1];
      expect(hashA).toBe(hashB);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty map for no input", async () => {
    const map = await processAssetFiles([], srcDir, outDir);
    expect(map.size).toBe(0);
  });
});

describe("copyStaticDir", () => {
  const staticDir = join(tmpDir, "static");
  const outDir = join(tmpDir, "dist");
  const cwd = tmpDir;

  test("copies static directory contents to outDir", async () => {
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, "robots.txt"), "User-agent: *");

    try {
      await copyStaticDir(staticDir, outDir, cwd);

      expect(existsSync(join(outDir, "robots.txt"))).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("does nothing if static dir does not exist", async () => {
    await copyStaticDir(join(tmpDir, "nonexistent"), outDir, cwd);
    expect(existsSync(outDir)).toBe(false);
  });
});
