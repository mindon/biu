// biu — import map helpers

export type ImportMapSpecifiers = ReadonlySet<string>;

const IMPORTMAP_SCRIPT_RE =
  /<script\b(?=[^>]*\btype\s*=\s*["']?importmap["']?)[^>]*>([\s\S]*?)<\/script>/gi;

const IMPORTS_BLOCK_RE =
  /(?:["']?imports["']?\s*:\s*\{)([\s\S]*?)(?=\}\s*[,}])/g;

const QUOTED_KEY_RE = /["']([^"'\n\r]+)["']\s*:/g;

function addImportMapKeys(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== "object") return;
  const map = value as {
    imports?: Record<string, unknown>;
    scopes?: Record<string, Record<string, unknown>>;
  };

  if (map.imports && typeof map.imports === "object") {
    for (const spec of Object.keys(map.imports)) out.add(spec);
  }

  if (map.scopes && typeof map.scopes === "object") {
    for (const scopeMap of Object.values(map.scopes)) {
      if (!scopeMap || typeof scopeMap !== "object") continue;
      for (const spec of Object.keys(scopeMap)) out.add(spec);
    }
  }
}

function extractImportsObjectKeys(code: string, out: Set<string>): void {
  for (const block of code.matchAll(IMPORTS_BLOCK_RE)) {
    for (const key of block[1].matchAll(QUOTED_KEY_RE)) {
      out.add(key[1]);
    }
  }
}

/** 从 HTML 中的 `<script type="importmap">` 提取 import map specifier。 */
export function extractHtmlImportMapSpecifiers(html: string): Set<string> {
  const out = new Set<string>();
  for (const match of html.matchAll(IMPORTMAP_SCRIPT_RE)) {
    const json = match[1].trim();
    if (!json) continue;
    try {
      addImportMapKeys(JSON.parse(json), out);
    } catch {
      // 宽松兜底：即使 importmap JSON 带注释/尾逗号等非标准写法，
      // 仍尽量从 imports 对象中提取 key，避免误安装/打包 CDN 依赖。
      extractImportsObjectKeys(json, out);
    }
  }
  return out;
}

/**
 * 从 JS/TS 中动态添加 importmap 的常见写法提取 specifier。
 * 支持：`script.type = "importmap"` 附近的 `JSON.stringify({ imports: ... })`
 * 或 importmap JSON/template 字符串。任意 JS 运行时代码无法完全静态求值，
 * 这里做保守的静态提取。
 */
export function extractCodeImportMapSpecifiers(code: string): Set<string> {
  const out = new Set<string>();
  if (!/importmap/i.test(code)) return out;
  extractImportsObjectKeys(code, out);
  return out;
}

export async function collectImportMapSpecifiers(
  htmlContents: string[],
  jsFiles: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const html of htmlContents) {
    for (const spec of extractHtmlImportMapSpecifiers(html)) out.add(spec);
  }

  await Promise.all(
    jsFiles.map(async (file) => {
      const code = await Bun.file(file).text();
      for (const spec of extractCodeImportMapSpecifiers(code)) out.add(spec);
    }),
  );

  return out;
}

function stripSpecSuffix(spec: string): string {
  let end = spec.length;
  const q = spec.indexOf("?");
  if (q >= 0) end = q;
  const h = spec.indexOf("#");
  if (h >= 0 && h < end) end = h;
  return spec.slice(0, end);
}

/** 判断一个模块 specifier 是否由 import map 接管。 */
export function isImportMapMapped(
  spec: string,
  importMapSpecifiers?: ImportMapSpecifiers,
): boolean {
  if (!importMapSpecifiers || importMapSpecifiers.size === 0) return false;
  const cleanSpec = stripSpecSuffix(spec);

  for (const key of importMapSpecifiers) {
    if (!key) continue;
    if (key.endsWith("/")) {
      if (spec.startsWith(key) || cleanSpec.startsWith(key)) return true;
    } else if (spec === key || cleanSpec === key) {
      return true;
    }
  }
  return false;
}
