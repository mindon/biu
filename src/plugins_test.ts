import { describe, expect, test } from "bun:test";
import { buildImportMapFilter } from "./plugins.ts";

describe("buildImportMapFilter", () => {
  test("returns null for empty specifier set", () => {
    expect(buildImportMapFilter(new Set())).toBeNull();
  });

  test("matches exact specifiers (with optional ?query/#hash)", () => {
    const re = buildImportMapFilter(new Set(["three"]))!;
    expect(re.test("three")).toBe(true);
    expect(re.test("three?foo")).toBe(true);
    expect(re.test("three#bar")).toBe(true);
    // must NOT match a longer specifier that merely starts with the key
    expect(re.test("threejs")).toBe(false);
    expect(re.test("three/extra")).toBe(false);
  });

  test("matches prefix (trailing-slash) specifiers", () => {
    const re = buildImportMapFilter(new Set(["three/addons/"]))!;
    expect(re.test("three/addons/")).toBe(true);
    expect(re.test("three/addons/OrbitControls.js")).toBe(true);
    expect(re.test("three/addonsX")).toBe(false);
  });

  test("escapes regex-special chars in keys", () => {
    const re = buildImportMapFilter(new Set(["@faker-js/faker@v7.1.0"]))!;
    expect(re.test("@faker-js/faker@v7.1.0")).toBe(true);
    // the `.` must be literal, not a wildcard
    expect(re.test("@faker-js/faker@v7X1Y0")).toBe(false);
  });

  test(
    "does NOT match unrelated bare specifiers — guards against the catch-all " +
      "/.* / regression that broke echarts tree-shaking (EH is not defined)",
    () => {
      const re = buildImportMapFilter(
        new Set([
          "@faker-js/faker@v7.1.0",
          "@lit/reactive-element/",
          "three",
          "three/addons/",
          "three/fonts/",
        ]),
      )!;
      for (
        const spec of [
          "echarts/core",
          "echarts/components",
          "echarts/charts",
          "echarts/features",
          "echarts/renderers",
          "zrender/lib/zrender.js",
          "tslib",
        ]
      ) {
        expect(re.test(spec)).toBe(false);
      }
    },
  );
});
