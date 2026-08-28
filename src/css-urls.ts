// biu — CSS url() token scanning

export interface CssUrlToken {
  /** Start offset of the `url` identifier. */
  start: number;
  /** End offset immediately after the closing parenthesis. */
  end: number;
  /** Trimmed raw argument, including its original quotes when present. */
  raw: string;
  /** Argument value with one pair of wrapping quotes removed. */
  value: string;
}

function isIdentChar(char: string | undefined): boolean {
  return !!char && /[a-z0-9_-]/i.test(char);
}

function skipQuoted(css: string, start: number): number {
  const quote = css[start];
  let i = start + 1;
  while (i < css.length) {
    if (css[i] === "\\") {
      i += 2;
      continue;
    }
    if (css[i] === quote) return i + 1;
    i++;
  }
  return css.length;
}

function unquote(raw: string): string {
  if (
    raw.length >= 2 &&
    (raw[0] === '"' || raw[0] === "'") &&
    raw.at(-1) === raw[0]
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Finds real CSS `url(...)` tokens without descending into comments, strings,
 * or a quoted URL's payload (such as an SVG data URI).
 */
export function scanCssUrls(css: string): CssUrlToken[] {
  const tokens: CssUrlToken[] = [];
  let i = 0;

  while (i < css.length) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (css[i] === '"' || css[i] === "'") {
      i = skipQuoted(css, i);
      continue;
    }
    if (
      css.slice(i, i + 3).toLowerCase() !== "url" ||
      isIdentChar(css[i - 1]) ||
      isIdentChar(css[i + 3])
    ) {
      i++;
      continue;
    }

    let open = i + 3;
    while (/\s/.test(css[open] ?? "")) open++;
    if (css[open] !== "(") {
      i++;
      continue;
    }

    let cursor = open + 1;
    let depth = 0;
    let end = -1;
    while (cursor < css.length) {
      const char = css[cursor];
      if (char === '"' || char === "'") {
        cursor = skipQuoted(css, cursor);
        continue;
      }
      if (char === "(") depth++;
      else if (char === ")") {
        if (depth === 0) {
          end = cursor + 1;
          break;
        }
        depth--;
      }
      cursor++;
    }
    if (end === -1) {
      i = open + 1;
      continue;
    }

    const raw = css.slice(open + 1, end - 1).trim();
    tokens.push({ start: i, end, raw, value: unquote(raw) });
    i = end;
  }

  return tokens;
}

export function isDataUrl(value: string): boolean {
  return /^data\s*:/i.test(value);
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
