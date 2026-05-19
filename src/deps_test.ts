import { describe, expect, test } from "bun:test";
import {
  extractImportSpecs,
  isValidPackageName,
  specToPackageName,
  stripNonImportStringsAndComments,
} from "./deps.ts";

// ==================== isValidPackageName ====================

describe("isValidPackageName", () => {
  test("simple valid names", () => {
    expect(isValidPackageName("lodash")).toBe(true);
    expect(isValidPackageName("dayjs")).toBe(true);
    expect(isValidPackageName("react")).toBe(true);
    expect(isValidPackageName("my-pkg")).toBe(true);
    expect(isValidPackageName("my.pkg")).toBe(true);
    expect(isValidPackageName("my_pkg")).toBe(true); // _ is valid inside package names
  });

  test("names with numbers", () => {
    expect(isValidPackageName("es6-promise")).toBe(true);
    expect(isValidPackageName("7zip-bin")).toBe(true);
  });

  test("scoped packages", () => {
    expect(isValidPackageName("@types/node")).toBe(true);
    expect(isValidPackageName("@babel/core")).toBe(true);
    expect(isValidPackageName("@vue/reactivity")).toBe(true);
    expect(isValidPackageName("@anthropic-ai/sdk")).toBe(true);
  });

  test("invalid: starts with dot", () => {
    expect(isValidPackageName(".hidden")).toBe(false);
  });

  test("invalid: starts with underscore", () => {
    expect(isValidPackageName("_private")).toBe(false);
  });

  test("invalid: uppercase", () => {
    expect(isValidPackageName("MyPkg")).toBe(false);
    expect(isValidPackageName("React")).toBe(false);
  });

  test("invalid: contains spaces", () => {
    expect(isValidPackageName("my pkg")).toBe(false);
  });

  test("invalid: empty string", () => {
    expect(isValidPackageName("")).toBe(false);
  });

  test("invalid: special characters", () => {
    expect(isValidPackageName("pkg!")).toBe(false);
    expect(isValidPackageName("pkg@latest")).toBe(false);
    expect(isValidPackageName("hello world")).toBe(false);
  });

  test("invalid: plain strings", () => {
    expect(isValidPackageName("hello")).toBe(true); // actually valid name
    expect(isValidPackageName("Hello")).toBe(false);
    expect(isValidPackageName("ALLCAPS")).toBe(false);
    expect(isValidPackageName("some random string")).toBe(false);
  });
});

// ==================== specToPackageName ====================

describe("specToPackageName", () => {
  test("bare package name", () => {
    expect(specToPackageName("lodash")).toBe("lodash");
    expect(specToPackageName("dayjs")).toBe("dayjs");
  });

  test("package with subpath", () => {
    expect(specToPackageName("lodash/chunk")).toBe("lodash");
    expect(specToPackageName("dayjs/plugin/utc")).toBe("dayjs");
  });

  test("scoped package", () => {
    expect(specToPackageName("@types/node")).toBe("@types/node");
    expect(specToPackageName("@babel/core")).toBe("@babel/core");
  });

  test("scoped package with subpath", () => {
    expect(specToPackageName("@vue/reactivity/dist/index")).toBe(
      "@vue/reactivity",
    );
  });

  test("invalid package name returns empty string", () => {
    expect(specToPackageName("Hello")).toBe("");
    expect(specToPackageName(".hidden")).toBe("");
    expect(specToPackageName("_private")).toBe("");
  });

  // ---- 含 ?query / #hash 后缀（bundler / loader 常见用法）----
  test("strips ?query suffix on bare package", () => {
    expect(specToPackageName("dayjs?v=1")).toBe("dayjs");
    expect(specToPackageName("lodash-es?worker")).toBe("lodash-es");
  });

  test("strips ?query suffix on package with subpath", () => {
    expect(specToPackageName("dayjs/plugin/utc?v=1")).toBe("dayjs");
    expect(specToPackageName("react/jsx-runtime?bundle")).toBe("react");
  });

  test("strips #hash suffix", () => {
    expect(specToPackageName("lodash-es#hash")).toBe("lodash-es");
    expect(specToPackageName("dayjs/plugin/utc#main")).toBe("dayjs");
  });

  test("strips ?query on scoped package", () => {
    expect(specToPackageName("@vue/reactivity?worker")).toBe("@vue/reactivity");
    expect(specToPackageName("@scope/pkg-name?query")).toBe("@scope/pkg-name");
  });

  test("strips #hash on scoped package with subpath", () => {
    expect(specToPackageName("@vue/reactivity/dist/index#esm")).toBe(
      "@vue/reactivity",
    );
  });

  test("strips both ?query and #hash, taking earliest", () => {
    expect(specToPackageName("dayjs?v=1#frag")).toBe("dayjs");
    expect(specToPackageName("dayjs#frag?v=1")).toBe("dayjs");
  });

  // ---- 退化的 scope-only spec 应视为无效 ----
  test("scope-only spec is invalid", () => {
    expect(specToPackageName("@scope")).toBe("");
    expect(specToPackageName("@scope?v=1")).toBe("");
    expect(specToPackageName("@scope/")).toBe("");
  });

  // ---- 多子入口 npm 包（如 echarts 通过 exports 暴露 /core、/charts 等）----
  test("npm package with multiple subpath entries (echarts)", () => {
    expect(specToPackageName("echarts/core")).toBe("echarts");
    expect(specToPackageName("echarts/charts")).toBe("echarts");
    expect(specToPackageName("echarts/components")).toBe("echarts");
    expect(specToPackageName("echarts/renderers")).toBe("echarts");
    expect(specToPackageName("echarts/lib/echarts")).toBe("echarts");
    expect(specToPackageName("echarts/core?v=5")).toBe("echarts");
  });

  test("extractImportSpecs picks up echarts subpath imports", () => {
    const code = `
      import * as echarts from 'echarts/core';
      import { BarChart } from "echarts/charts";
      import { GridComponent } from 'echarts/components';
      import { CanvasRenderer } from "echarts/renderers";
    `;
    const specs = [...extractImportSpecs(code)];
    expect(specs).toContain("echarts/core");
    expect(specs).toContain("echarts/charts");
    expect(specs).toContain("echarts/components");
    expect(specs).toContain("echarts/renderers");
    // 全部应归一到同一个安装包名
    const pkgs = new Set(specs.map(specToPackageName));
    expect(pkgs).toEqual(new Set(["echarts"]));
  });
});

// ==================== stripNonImportStringsAndComments ====================

describe("stripNonImportStringsAndComments", () => {
  test("preserves import specifier strings", () => {
    const code = `import dayjs from "dayjs";`;
    const result = stripNonImportStringsAndComments(code);
    expect(result).toContain('"dayjs"');
  });

  test("preserves export from specifier", () => {
    const code = `export { chunk } from "lodash-es";`;
    const result = stripNonImportStringsAndComments(code);
    expect(result).toContain('"lodash-es"');
  });

  test("preserves require specifier", () => {
    const code = `const x = require("dayjs");`;
    const result = stripNonImportStringsAndComments(code);
    expect(result).toContain('"dayjs"');
  });

  test("preserves side-effect import", () => {
    const code = `import "polyfill";`;
    const result = stripNonImportStringsAndComments(code);
    expect(result).toContain('"polyfill"');
  });

  test("strips line comments", () => {
    const code =
      `// import ghost from "ghost-pkg";\nimport dayjs from "dayjs";`;
    const result = stripNonImportStringsAndComments(code);
    expect(result).not.toContain("ghost");
    expect(result).toContain('"dayjs"');
  });

  test("strips block comments", () => {
    const code =
      `/* import phantom from "phantom-pkg"; */\nimport dayjs from "dayjs";`;
    const result = stripNonImportStringsAndComments(code);
    expect(result).not.toContain("phantom");
    expect(result).toContain('"dayjs"');
  });

  test("strips multi-line block comments", () => {
    const code =
      `/*\nimport a from "fake-a";\nexport * from "fake-b";\n*/\nimport dayjs from "dayjs";`;
    const result = stripNonImportStringsAndComments(code);
    expect(result).not.toContain("fake-a");
    expect(result).not.toContain("fake-b");
    expect(result).toContain('"dayjs"');
  });

  test("strips non-import double-quoted strings", () => {
    const code =
      `const a = "import foo from 'fake-pkg'";\nimport dayjs from "dayjs";`;
    const result = stripNonImportStringsAndComments(code);
    expect(result).not.toContain("fake-pkg");
    expect(result).toContain('"dayjs"');
  });

  test("strips non-import single-quoted strings", () => {
    const code =
      `const b = 'export { bar } from "fake-pkg"';\nimport dayjs from "dayjs";`;
    const result = stripNonImportStringsAndComments(code);
    expect(result).not.toContain("fake-pkg");
    expect(result).toContain('"dayjs"');
  });

  test("strips simple template string", () => {
    const code = 'const c = `import "fake-pkg"`;\nimport dayjs from "dayjs";';
    const result = stripNonImportStringsAndComments(code);
    expect(result).not.toContain("fake-pkg");
    expect(result).toContain('"dayjs"');
  });

  test("strips multi-line template string", () => {
    const code = [
      "const d = `",
      '  import something from "fake-tmpl-a";',
      '  export * from "fake-tmpl-b";',
      "`;",
      'import dayjs from "dayjs";',
    ].join("\n");
    const result = stripNonImportStringsAndComments(code);
    expect(result).not.toContain("fake-tmpl-a");
    expect(result).not.toContain("fake-tmpl-b");
    expect(result).toContain('"dayjs"');
  });

  test("strips nested template string with interpolation", () => {
    const code = [
      "const e = `outer ${`inner`} text",
      '  import wrong from "fake-nested";',
      "`;",
      'import dayjs from "dayjs";',
    ].join("\n");
    const result = stripNonImportStringsAndComments(code);
    expect(result).not.toContain("fake-nested");
    expect(result).toContain('"dayjs"');
  });

  test("strips deeply nested template strings", () => {
    const code = [
      "const g = `a ${`b ${`c`} d`} e",
      '  import deep from "fake-deep";',
      "`;",
      'import dayjs from "dayjs";',
    ].join("\n");
    const result = stripNonImportStringsAndComments(code);
    expect(result).not.toContain("fake-deep");
    expect(result).toContain('"dayjs"');
  });

  test("strips template with complex interpolation containing fake import", () => {
    const code = [
      "const f = `value is ${(() => {",
      "  const x = \"import evil from 'fake-interp'\";",
      "  return x;",
      "})()}",
      '  import also_wrong from "fake-interp-2";',
      "`;",
      'import dayjs from "dayjs";',
    ].join("\n");
    const result = stripNonImportStringsAndComments(code);
    expect(result).not.toContain("fake-interp");
    expect(result).not.toContain("fake-interp-2");
    expect(result).toContain('"dayjs"');
  });

  test("preserves newlines in multi-line content", () => {
    const code = 'const x = `\nline1\nline2\n`;\nimport a from "a";';
    const result = stripNonImportStringsAndComments(code);
    // Count newlines — should be preserved
    const origNL = (code.match(/\n/g) || []).length;
    const resultNL = (result.match(/\n/g) || []).length;
    expect(resultNL).toBe(origNL);
  });

  test("handles escaped quotes in strings", () => {
    const code = `const s = "he said \\"import x from 'fake'\\"";
import dayjs from "dayjs";`;
    const result = stripNonImportStringsAndComments(code);
    expect(result).not.toContain("fake");
    expect(result).toContain('"dayjs"');
  });

  test("handles escaped backtick in template", () => {
    const code =
      'const t = `escaped \\` backtick`;\nimport dayjs from "dayjs";';
    const result = stripNonImportStringsAndComments(code);
    expect(result).toContain('"dayjs"');
  });
});

// ==================== extractImportSpecs ====================

describe("extractImportSpecs", () => {
  // ---- Real imports: should be detected ----

  test("ESM default import", () => {
    const specs = extractImportSpecs(`import dayjs from "dayjs";`);
    expect(specs.has("dayjs")).toBe(true);
  });

  test("ESM named import", () => {
    const specs = extractImportSpecs(
      `import { chunk, map } from "lodash-es";`,
    );
    expect(specs.has("lodash-es")).toBe(true);
  });

  test("ESM namespace import", () => {
    const specs = extractImportSpecs(`import * as path from "node:path";`);
    // node: protocol should be filtered
    expect(specs.has("node:path")).toBe(false);
    expect(specs.size).toBe(0);
  });

  test("ESM side-effect import", () => {
    const specs = extractImportSpecs(`import "polyfill";`);
    expect(specs.has("polyfill")).toBe(true);
  });

  test("ESM re-export", () => {
    const specs = extractImportSpecs(`export { foo } from "bar-pkg";`);
    expect(specs.has("bar-pkg")).toBe(true);
  });

  test("ESM export * from", () => {
    const specs = extractImportSpecs(`export * from "reexport-pkg";`);
    expect(specs.has("reexport-pkg")).toBe(true);
  });

  test("CJS require", () => {
    const specs = extractImportSpecs(`const x = require("cjs-pkg");`);
    expect(specs.has("cjs-pkg")).toBe(true);
  });

  test("scoped package", () => {
    const specs = extractImportSpecs(
      `import sdk from "@anthropic-ai/sdk";`,
    );
    expect(specs.has("@anthropic-ai/sdk")).toBe(true);
  });

  test("package with subpath", () => {
    const specs = extractImportSpecs(
      `import utc from "dayjs/plugin/utc";`,
    );
    expect(specs.has("dayjs/plugin/utc")).toBe(true);
  });

  test("multiple imports in one file", () => {
    const code = [
      'import dayjs from "dayjs";',
      'import { chunk } from "lodash-es";',
      'const fs = require("fs-extra");',
      'export { helper } from "my-helpers";',
    ].join("\n");
    const specs = extractImportSpecs(code);
    expect(specs.has("dayjs")).toBe(true);
    expect(specs.has("lodash-es")).toBe(true);
    expect(specs.has("fs-extra")).toBe(true);
    expect(specs.has("my-helpers")).toBe(true);
    expect(specs.size).toBe(4);
  });

  // ---- Filtered: relative / absolute / URL / protocol ----

  test("filters relative paths", () => {
    const specs = extractImportSpecs(`import x from "./local";`);
    expect(specs.size).toBe(0);
  });

  test("filters parent relative paths", () => {
    const specs = extractImportSpecs(`import x from "../parent";`);
    expect(specs.size).toBe(0);
  });

  test("filters absolute paths", () => {
    const specs = extractImportSpecs(`import x from "/absolute/path";`);
    expect(specs.size).toBe(0);
  });

  test("filters http URLs", () => {
    const specs = extractImportSpecs(
      `import x from "https://cdn.example.com/pkg.js";`,
    );
    expect(specs.size).toBe(0);
  });

  test("filters node: protocol", () => {
    const specs = extractImportSpecs(`import fs from "node:fs";`);
    expect(specs.size).toBe(0);
  });

  test("filters bun: protocol", () => {
    const specs = extractImportSpecs(`import { $ } from "bun:test";`);
    expect(specs.size).toBe(0);
  });

  // ---- False positives: should NOT be detected ----

  test("ignores import in double-quoted string", () => {
    const specs = extractImportSpecs(
      `const a = "import foo from 'fake-pkg-a'";`,
    );
    expect(specs.size).toBe(0);
  });

  test("ignores import in single-quoted string", () => {
    const specs = extractImportSpecs(
      `const b = 'export { bar } from "fake-pkg-b"';`,
    );
    expect(specs.size).toBe(0);
  });

  test("ignores import in template string", () => {
    const specs = extractImportSpecs(
      'const c = `import "fake-pkg-c"`;',
    );
    expect(specs.size).toBe(0);
  });

  test("ignores import in multi-line template string", () => {
    const code = [
      "const d = `",
      '  import something from "fake-pkg-d";',
      '  export * from "fake-pkg-e";',
      '  const r = require("fake-pkg-f");',
      "`;",
    ].join("\n");
    const specs = extractImportSpecs(code);
    expect(specs.size).toBe(0);
  });

  test("ignores import in nested template string", () => {
    const code = [
      "const e = `outer ${`inner`} text",
      '  import wrong from "fake-pkg-g";',
      "`;",
    ].join("\n");
    const specs = extractImportSpecs(code);
    expect(specs.size).toBe(0);
  });

  test("ignores import in deeply nested template string", () => {
    const code = [
      "const g = `a ${`b ${`c`} d`} e",
      '  import deep from "fake-pkg-h";',
      "`;",
    ].join("\n");
    const specs = extractImportSpecs(code);
    expect(specs.size).toBe(0);
  });

  test("ignores import in line comment", () => {
    const specs = extractImportSpecs(
      `// import ghost from "fake-pkg-i";`,
    );
    expect(specs.size).toBe(0);
  });

  test("ignores import in block comment", () => {
    const specs = extractImportSpecs(
      `/* import phantom from "fake-pkg-j"; */`,
    );
    expect(specs.size).toBe(0);
  });

  test("ignores import in multi-line block comment", () => {
    const code = [
      "/*",
      ' * import a from "fake-pkg-k";',
      ' * export { b } from "fake-pkg-l";',
      " */",
    ].join("\n");
    const specs = extractImportSpecs(code);
    expect(specs.size).toBe(0);
  });

  test("ignores Array.from and Buffer.from", () => {
    const code = [
      'const arr = Array.from("hello");',
      'const buf = Buffer.from("test");',
    ].join("\n");
    const specs = extractImportSpecs(code);
    expect(specs.size).toBe(0);
  });

  test("ignores require-like in non-require context", () => {
    const specs = extractImportSpecs(
      `const msg = "You require('patience')";`,
    );
    expect(specs.size).toBe(0);
  });

  // ---- Mixed: real + fake in same file ----

  test("detects real imports while ignoring fakes in same file", () => {
    const code = [
      'import dayjs from "dayjs";',
      'import { chunk } from "lodash-es";',
      "",
      "// Fakes:",
      "const a = \"import foo from 'fake-a'\";",
      'const b = `import "fake-b"`;',
      '// import ghost from "fake-c";',
      '/* import phantom from "fake-d"; */',
      "const tmpl = `",
      '  import wrong from "fake-e";',
      "`;",
      "const nested = `outer ${`inner`}",
      '  import bad from "fake-f";',
      "`;",
      'const arr = Array.from("hello");',
    ].join("\n");
    const specs = extractImportSpecs(code);
    expect(specs.has("dayjs")).toBe(true);
    expect(specs.has("lodash-es")).toBe(true);
    expect(specs.size).toBe(2);
  });

  test("handles template with interpolation followed by real import", () => {
    const code = [
      "const x = `a${`b`}c`;",
      "",
      'import dayjs from "dayjs";',
      "",
      'const y = `hello ${"world"} end`;',
      "",
      'import { chunk } from "lodash-es";',
    ].join("\n");
    const specs = extractImportSpecs(code);
    expect(specs.has("dayjs")).toBe(true);
    expect(specs.has("lodash-es")).toBe(true);
    expect(specs.size).toBe(2);
  });
});
