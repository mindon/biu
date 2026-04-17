import { describe, expect, test } from "bun:test";
import { ASSET_EXTS, MANAGED_EXTS, USAGE, VERSION } from "./constants.ts";

describe("constants", () => {
  test("VERSION contains version string", () => {
    expect(VERSION).toContain("biu v");
    expect(VERSION).toContain("mindon");
  });

  test("USAGE contains all CLI options", () => {
    expect(USAGE).toContain("--watch");
    expect(USAGE).toContain("--static");
    expect(USAGE).toContain("--serve");
    expect(USAGE).toContain("--build");
    expect(USAGE).toContain("--post-build");
    expect(USAGE).toContain("-v, --version");
    expect(USAGE).toContain("-h, --help");
  });

  describe("MANAGED_EXTS", () => {
    test("includes TypeScript/JavaScript extensions", () => {
      expect(MANAGED_EXTS.has(".ts")).toBe(true);
      expect(MANAGED_EXTS.has(".js")).toBe(true);
      expect(MANAGED_EXTS.has(".mts")).toBe(true);
      expect(MANAGED_EXTS.has(".mjs")).toBe(true);
    });

    test("includes HTML extensions", () => {
      expect(MANAGED_EXTS.has(".html")).toBe(true);
      expect(MANAGED_EXTS.has(".htm")).toBe(true);
    });

    test("includes CSS/SCSS extensions", () => {
      expect(MANAGED_EXTS.has(".css")).toBe(true);
      expect(MANAGED_EXTS.has(".scss")).toBe(true);
      expect(MANAGED_EXTS.has(".sass")).toBe(true);
    });

    test("does not include asset extensions", () => {
      expect(MANAGED_EXTS.has(".png")).toBe(false);
      expect(MANAGED_EXTS.has(".json")).toBe(false);
    });
  });

  describe("ASSET_EXTS", () => {
    test("includes image extensions", () => {
      for (
        const ext of [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"]
      ) {
        expect(ASSET_EXTS.has(ext)).toBe(true);
      }
    });

    test("includes font extensions", () => {
      for (const ext of [".woff", ".woff2", ".ttf", ".otf", ".eot"]) {
        expect(ASSET_EXTS.has(ext)).toBe(true);
      }
    });

    test("includes audio/video extensions", () => {
      for (const ext of [".mp3", ".ogg", ".wav", ".mp4", ".webm"]) {
        expect(ASSET_EXTS.has(ext)).toBe(true);
      }
    });

    test("includes other common extensions", () => {
      for (const ext of [".json", ".xml", ".csv", ".pdf", ".wasm"]) {
        expect(ASSET_EXTS.has(ext)).toBe(true);
      }
    });

    test("does not include managed extensions", () => {
      expect(ASSET_EXTS.has(".ts")).toBe(false);
      expect(ASSET_EXTS.has(".html")).toBe(false);
      expect(ASSET_EXTS.has(".css")).toBe(false);
    });
  });
});
