import { describe, expect, test } from "bun:test";
import {
  extractCodeImportMapSpecifiers,
  extractHtmlImportMapSpecifiers,
  isImportMapMapped,
} from "./importmaps.ts";

describe("import map helpers", () => {
  test("extracts imports from HTML importmap script", () => {
    const specs = extractHtmlImportMapSpecifiers(`
      <script type="importmap">
      {
        "imports": {
          "lit": "https://cdn.example.com/lit.js",
          "@lit/reactive-element/": "https://cdn.example.com/re/"
        }
      }
      </script>
    `);
    expect(specs.has("lit")).toBe(true);
    expect(specs.has("@lit/reactive-element/")).toBe(true);
  });

  test("extracts imports from dynamically created importmap code", () => {
    const specs = extractCodeImportMapSpecifiers(`
      const s = document.createElement("script");
      s.type = "importmap";
      s.textContent = JSON.stringify({
        imports: {
          "cdn-pkg": "https://cdn.example.com/cdn-pkg.js",
          "cdn-prefix/": "https://cdn.example.com/cdn-prefix/"
        }
      });
      document.head.appendChild(s);
    `);
    expect(specs.has("cdn-pkg")).toBe(true);
    expect(specs.has("cdn-prefix/")).toBe(true);
  });

  test("matches exact and prefix importmap specifiers", () => {
    const specs = new Set(["lit", "@scope/pkg/"]);
    expect(isImportMapMapped("lit", specs)).toBe(true);
    expect(isImportMapMapped("lit/subpath", specs)).toBe(false);
    expect(isImportMapMapped("@scope/pkg/core", specs)).toBe(true);
    expect(isImportMapMapped("@scope/other/core", specs)).toBe(false);
  });
});
