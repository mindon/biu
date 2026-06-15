// biu — auto-detect and install missing npm dependencies

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DependsMode } from "./cli.ts";
import { type ImportMapSpecifiers, isImportMapMapped } from "./importmaps.ts";

const CACHE_FILE = ".biu-deps";

/** import/require 模式（仅在已剥离字符串和注释的代码上运行） */
const IMPORT_PATTERNS: RegExp[] = [
  // ESM: import/export ... from "pkg"（必须前置 import/export 关键字）
  /\b(?:import|export)\s+[\s\S]*?\bfrom\s*["']([^"']+)["']/g,
  // ESM side-effect: import "pkg"（仅 import 后直接跟字符串，无绑定）
  /\bimport\s*["']([^"']+)["']/g,
  // CJS: require("pkg") — 仅单参数形式（右括号紧跟引号后）
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/**
 * npm 包名合法性校验（简化版）
 * 合法包名规则：
 *  - 不能为空，不能以 . 或 _ 开头
 *  - 只含小写字母、数字、连字符、点号（scoped 包以 @ 开头含 /）
 *  - 不能含空格或特殊字符
 */
const VALID_PKG_NAME_RE = /^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/;

/** @internal — exported for testing */
export function isValidPackageName(name: string): boolean {
  return VALID_PKG_NAME_RE.test(name);
}

/**
 * 剥离代码中的字符串字面量（单引号/双引号/模板字符串）和注释，
 * 将其替换为空格（保留换行），避免正则误匹配字符串/注释中的内容。
 *
 * 对于 import/export/require 语句的 specifier 引号字符串则保留原文。
 *
 * 使用状态机逐字符扫描，正确处理：
 *  - 行注释 // ...
 *  - 块注释 /* ... * /
 *  - 单/双引号字符串（含转义）
 *  - 模板字符串（含 ${...} 嵌套，可跨行，可嵌套模板字符串）
 */
/** @internal — exported for testing */
export function stripNonImportStringsAndComments(code: string): string {
  const out: string[] = [];
  const len = code.length;
  let i = 0;

  while (i < len) {
    const ch = code[i];
    const next = i + 1 < len ? code[i + 1] : "";

    // ---- 行注释 ----
    if (ch === "/" && next === "/") {
      while (i < len && code[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    // ---- 块注释 ----
    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < len) {
        if (code[i] === "*" && i + 1 < len && code[i + 1] === "/") {
          out.push(" ", " ");
          i += 2;
          break;
        }
        out.push(code[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    // ---- 模板字符串（反引号） ----
    if (ch === "`") {
      consumeTemplateLiteral();
      continue;
    }

    // ---- 单/双引号字符串 ----
    if (ch === '"' || ch === "'") {
      consumeQuotedString(ch);
      continue;
    }

    // ---- 普通字符，原样输出 ----
    out.push(ch);
    i++;
  }

  return out.join("");

  /**
   * 消费一个模板字符串（从开头的 ` 开始），
   * 将所有非换行内容替换为空格，正确追踪 ${...} 嵌套。
   */
  function consumeTemplateLiteral(): void {
    out.push(" "); // 开头的 `
    i++;
    while (i < len) {
      const c = code[i];
      if (c === "\\") {
        // 转义：跳过下一个字符
        out.push(" ", code[i + 1] === "\n" ? "\n" : " ");
        i += 2;
        continue;
      }
      if (c === "`") {
        // 模板字符串结束
        out.push(" ");
        i++;
        return;
      }
      if (c === "$" && i + 1 < len && code[i + 1] === "{") {
        // ${...} 插值：剥离 ${ ，然后递归扫描插值内的普通代码
        out.push(" ", " ");
        i += 2;
        consumeInterpolation();
        continue;
      }
      // 普通字符
      out.push(c === "\n" ? "\n" : " ");
      i++;
    }
  }

  /**
   * 消费 ${...} 插值内部——这是普通的 JS 代码，需要追踪花括号嵌套，
   * 并递归处理内部的字符串/注释/模板字符串。
   * 插值内的代码原样输出（不剥离），因为其中可能有真正的 import()。
   */
  function consumeInterpolation(): void {
    let depth = 1;
    while (i < len && depth > 0) {
      const c = code[i];
      const nx = i + 1 < len ? code[i + 1] : "";

      // 行注释
      if (c === "/" && nx === "/") {
        while (i < len && code[i] !== "\n") {
          out.push(" ");
          i++;
        }
        continue;
      }
      // 块注释
      if (c === "/" && nx === "*") {
        out.push(" ", " ");
        i += 2;
        while (i < len) {
          if (code[i] === "*" && i + 1 < len && code[i + 1] === "/") {
            out.push(" ", " ");
            i += 2;
            break;
          }
          out.push(code[i] === "\n" ? "\n" : " ");
          i++;
        }
        continue;
      }

      // 嵌套模板字符串
      if (c === "`") {
        consumeTemplateLiteral();
        continue;
      }
      // 单/双引号字符串
      if (c === '"' || c === "'") {
        // 插值内的字符串也需要剥离
        consumeQuotedStringBlank(c);
        continue;
      }
      // 花括号嵌套追踪
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (depth === 0) {
          out.push(" "); // 闭合的 }
          i++;
          return;
        }
      }
      out.push(c);
      i++;
    }
  }

  /**
   * 消费单/双引号字符串——根据所在行上下文决定保留还是剥离。
   * 如果该字符串位于 import/export/require 语句中，保留原文；否则替换为空格。
   */
  function consumeQuotedString(quote: string): void {
    // 判断是否在 import/export/require 语句中
    const lineStart = code.lastIndexOf("\n", i - 1) + 1;
    const linePrefix = code.slice(lineStart, i).trimStart();
    const keep = /^(?:import|export)\b/.test(linePrefix) ||
      /\bfrom\s*$/.test(linePrefix) ||
      /\brequire\s*\(\s*$/.test(linePrefix);

    if (keep) {
      // 保留原文
      out.push(code[i]); // 开头引号
      i++;
      while (i < len) {
        const c = code[i];
        if (c === "\\") {
          out.push(code[i], code[i + 1] ?? "");
          i += 2;
          continue;
        }
        out.push(c);
        i++;
        if (c === quote) return;
      }
    } else {
      consumeQuotedStringBlank(quote);
    }
  }

  /** 消费单/双引号字符串，内容替换为空格 */
  function consumeQuotedStringBlank(quote: string): void {
    out.push(" "); // 开头引号
    i++;
    while (i < len) {
      const c = code[i];
      if (c === "\\") {
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (c === quote) {
        out.push(" ");
        i++;
        return;
      }
      out.push(c === "\n" ? "\n" : " ");
      i++;
    }
  }
}

/**
 * 从代码中提取所有 import specifier（原始值）
 * 先剥离字符串和注释，再用正则匹配，避免误匹配
 */
/** @internal — exported for testing */
export function extractImportSpecs(code: string): Set<string> {
  const cleaned = stripNonImportStringsAndComments(code);
  const specs = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    for (const m of cleaned.matchAll(pattern)) {
      const spec = m[1];
      // 相对路径
      if (spec.startsWith("./") || spec.startsWith("../")) continue;
      // 绝对路径
      if (spec.startsWith("/")) continue;
      // URL
      if (/^https?:\/\//.test(spec)) continue;
      // node:/bun: 协议
      if (spec.startsWith("node:") || spec.startsWith("bun:")) continue;
      specs.add(spec);
    }
  }
  return specs;
}

/**
 * 剥离 specifier 末尾的 `?query` 与 `#hash`（按先出现者切断）。
 * 例如 `dayjs/plugin/utc?v=1` -> `dayjs/plugin/utc`，
 * `pkg#hash` -> `pkg`。
 */
function stripSpecSuffix(spec: string): string {
  let end = spec.length;
  const q = spec.indexOf("?");
  if (q >= 0) end = q;
  const h = spec.indexOf("#");
  if (h >= 0 && h < end) end = h;
  return spec.slice(0, end);
}

/** 从 specifier 提取 npm 包名（@scope/pkg 或 pkg），无效则返回空串 */
/** @internal — exported for testing */
export function specToPackageName(spec: string): string {
  // 先剥离 ?query / #hash 后缀，再按 / 切分
  const clean = stripSpecSuffix(spec);
  if (!clean) return "";
  const parts = clean.split("/");
  let name: string;
  if (parts[0].startsWith("@")) {
    // scoped 包必须带子段，单独的 `@scope` 视为无效
    if (parts.length < 2 || !parts[1]) return "";
    name = `${parts[0]}/${parts[1]}`;
  } else {
    name = parts[0];
  }
  return isValidPackageName(name) ? name : "";
}

/**
 * 找到最近的 node_modules 目录（从 startDir 向上查找）
 */
function findNodeModulesDir(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const nm = join(dir, "node_modules");
    if (existsSync(nm)) return nm;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 找到最近的 package.json 所在目录
 */
function findPackageRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 检查一个 npm 包是否已安装
 */
function isInstalled(pkg: string, nodeModulesDir: string): boolean {
  return existsSync(join(nodeModulesDir, pkg, "package.json"));
}

/**
 * 对文件列表和包集合生成一个摘要 hash，用于判断依赖是否有变化
 * 包含：排序后的包名列表 + 每个源文件的 mtime
 */
async function computeDepsHash(
  jsFiles: string[],
  pkgs: Set<string>,
): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  // 包名列表（排序保证稳定性）
  h.update([...pkgs].sort().join("\n"));
  h.update("\x00");
  // 每个源文件的修改时间（排序后），比读内容 hash 轻量得多
  const mtimes = await Promise.all(
    jsFiles.map(async (f) => {
      try {
        const s = await stat(f);
        return `${f}:${s.mtimeMs}`;
      } catch {
        return `${f}:0`;
      }
    }),
  );
  h.update(mtimes.sort().join("\n"));
  return h.digest("hex").slice(0, 16);
}

/**
 * 读取上次的缓存 hash
 */
async function readCacheHash(installDir: string): Promise<string | null> {
  try {
    return (await Bun.file(join(installDir, CACHE_FILE)).text()).trim();
  } catch {
    return null;
  }
}

/**
 * 写入缓存 hash
 */
async function writeCacheHash(
  installDir: string,
  hash: string,
): Promise<void> {
  await Bun.write(join(installDir, CACHE_FILE), hash + "\n");
}

/**
 * 扫描源文件，检测缺失的 npm 依赖，根据 mode 执行不同操作：
 *  - auto  : 自动安装缺失依赖（默认行为）
 *  - json  : 将依赖记录到指定 JSON 文件（package.json 格式），不安装
 *  - txt   : 将依赖记录到指定 TXT 文件（每行 package,version），不安装
 *
 * 返回检测到的所有 npm 包名列表
 */
export async function autoInstallDeps(
  jsFiles: string[],
  srcDir: string,
  mode: DependsMode = { kind: "auto" },
  importMapSpecifiers?: ImportMapSpecifiers,
): Promise<string[]> {
  const pkgRoot = findPackageRoot(srcDir);
  const installDir = pkgRoot || dirname(srcDir);

  // 并行读取所有 JS/TS 文件，提取 npm 包引用
  const allPkgs = new Set<string>();
  await Promise.all(
    jsFiles.map(async (file) => {
      const code = await Bun.file(file).text();
      const dir = dirname(file);
      for (const spec of extractImportSpecs(code)) {
        // import map 接管的 bare specifier 由浏览器解析，不能当 npm 包安装。
        if (isImportMapMapped(spec, importMapSpecifiers)) continue;
        // extractImportSpecs 已过滤掉相对路径/绝对路径/URL/node:|bun:
        // 但 spec 仍可能携带 ?query / #hash 后缀，需先剥离再做本地路径判断
        const cleanSpec = stripSpecSuffix(spec);
        if (!cleanSpec) continue;
        // 防御性：如果 srcDir 内恰好存在与 spec 同名的目录/文件
        // （例如内部 alias 指向源码内某个目录），视为本地依赖跳过
        const localPath = join(dir, cleanSpec);
        if (existsSync(localPath)) continue;
        const name = specToPackageName(spec);
        if (name) allPkgs.add(name);
      }
    }),
  );

  if (allPkgs.size === 0) return [];

  const allPkgNames = [...allPkgs].sort();

  // ---------- json / txt 模式：只记录，不安装 ----------
  if (mode.kind === "json") {
    const outFile = resolve(installDir, mode.file);
    await recordDepsToJson(allPkgNames, outFile);
    console.log(`📋 Dependencies recorded to ${outFile}`);
    return allPkgNames;
  }
  if (mode.kind === "txt") {
    const outFile = resolve(installDir, mode.file);
    await recordDepsToTxt(allPkgNames, outFile);
    console.log(`📋 Dependencies recorded to ${outFile}`);
    return allPkgNames;
  }

  // ---------- auto / confirm 模式：检测并安装 ----------
  const isConfirm = mode.kind === "confirm";

  // 快速路径：缓存 hash 匹配且 node_modules 存在 → 跳过
  const nodeModulesDir = findNodeModulesDir(srcDir);
  const depsHash = await computeDepsHash(jsFiles, allPkgs);
  const cachedHash = await readCacheHash(installDir);

  if (cachedHash === depsHash && nodeModulesDir) {
    return []; // 源文件和依赖集合均未变化，跳过
  }

  // 筛选出未安装的包
  const missing: string[] = [];
  for (const pkg of allPkgs) {
    if (nodeModulesDir && isInstalled(pkg, nodeModulesDir)) continue;
    missing.push(pkg);
  }

  if (missing.length === 0) {
    // 全部已安装但缓存过期 → 更新缓存以加速后续构建
    await writeCacheHash(installDir, depsHash);
    return [];
  }

  // ---------- confirm 模式：列出依赖，等待用户确认 ----------
  if (isConfirm) {
    console.log(`\n📦 Missing dependencies detected:`);
    for (const pkg of missing) {
      console.log(`   • ${pkg}`);
    }
    console.log(`\n   install dir: ${installDir}`);

    const confirmed = await promptYesNo(
      "Install these dependencies? (y/n): ",
    );

    if (confirmed) {
      // y → 同 auto，执行安装
      return await installPackages(missing, installDir, jsFiles, allPkgs);
    } else {
      // n → 同 json，记录到 package.json
      const outFile = resolve(installDir, "package.json");
      await recordDepsToJson(missing, outFile);
      console.log(`📋 Dependencies recorded to ${outFile} (skipped install)`);
      return missing;
    }
  }

  // ---------- auto 模式：直接安装 ----------
  return await installPackages(missing, installDir, jsFiles, allPkgs);
}

// ======================== 安装 & 交互 ========================

/**
 * 检测 `bun` CLI 是否在 PATH 中可用。
 * 通过执行 `bun --version` 探测；任意异常或非 0 退出码均视为不可用。
 * 结果缓存到模块作用域，避免重复探测。
 */
let _bunAvailable: boolean | undefined;
async function isBunAvailable(): Promise<boolean> {
  if (_bunAvailable !== undefined) return _bunAvailable;
  try {
    const proc = Bun.spawn(["bun", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    _bunAvailable = code === 0;
  } catch {
    _bunAvailable = false;
  }
  return _bunAvailable;
}

/**
 * 尝试自动安装 Bun 运行时。
 * - macOS / Linux: 通过官方一键脚本 `curl -fsSL https://bun.sh/install | bash`
 * - Windows: 通过 PowerShell `irm bun.sh/install.ps1 | iex`
 *
 * 安装到默认位置后，将 `~/.bun/bin`（或 Windows 的 `%USERPROFILE%\.bun\bin`）
 * 追加到当前进程的 PATH，使后续 `Bun.spawn(["bun", ...])` 可以找到二进制。
 *
 * 返回安装并探测成功与否。
 */
async function tryInstallBun(): Promise<boolean> {
  const platform = process.platform;
  console.log(`\n🚀 Attempting to install Bun automatically (${platform})…`);

  let cmd: string[];
  if (platform === "win32") {
    // PowerShell one-liner from https://bun.sh
    cmd = [
      "powershell",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "irm bun.sh/install.ps1 | iex",
    ];
  } else {
    // bash + curl one-liner from https://bun.sh
    cmd = ["bash", "-c", "curl -fsSL https://bun.sh/install | bash"];
  }

  try {
    const proc = Bun.spawn(cmd, {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`❌ Bun installer exited with code ${code}.`);
      return false;
    }
  } catch (err) {
    console.error(`❌ Failed to launch Bun installer:`, err);
    return false;
  }

  // 将默认 bun 安装目录追加到 PATH 以便当前进程能立刻使用
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) {
    const bunBin = platform === "win32"
      ? `${home}\\.bun\\bin`
      : `${home}/.bun/bin`;
    const sep = platform === "win32" ? ";" : ":";
    const currentPath = process.env.PATH || "";
    if (!currentPath.split(sep).includes(bunBin)) {
      process.env.PATH = `${bunBin}${sep}${currentPath}`;
    }
  }

  // 重新探测
  _bunAvailable = undefined;
  const ok = await isBunAvailable();
  if (ok) {
    console.log(`✅ Bun installed and ready.\n`);
  } else {
    console.error(
      `❌ Bun installer finished but \`bun\` is still not available in PATH.\n` +
        `   You may need to restart your shell, or add Bun's bin directory to PATH manually.`,
    );
  }
  return ok;
}

/**
 * 执行 bun add 安装缺失包，并更新缓存
 */
async function installPackages(
  missing: string[],
  installDir: string,
  jsFiles: string[],
  allPkgs: Set<string>,
): Promise<string[]> {
  console.log(
    `\n📦 Auto-installing missing dependencies: ${missing.join(", ")}`,
  );
  console.log(`   install dir: ${installDir}`);

  if (!(await isBunAvailable())) {
    console.warn(
      `⚠️  \`bun\` CLI not found in PATH — will try to install Bun first.`,
    );
    const installed = await tryInstallBun();
    if (!installed) {
      console.error(
        `❌ Cannot auto-install dependencies without \`bun\`.\n` +
          `   Install Bun manually from https://bun.sh, or rerun with ` +
          `\`--depends json\` to record deps to package.json instead.\n` +
          `   Missing: ${missing.join(", ")}`,
      );
      process.exit(1);
    }
  }

  const proc = Bun.spawn(["bun", "add", ...missing], {
    cwd: installDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`❌ Failed to install: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log(`✅ Installed: ${missing.join(", ")}\n`);

  // 安装成功后更新缓存
  const depsHash = await computeDepsHash(jsFiles, allPkgs);
  await writeCacheHash(installDir, depsHash);
  const { argv, execPath } = process;
  const rebiuFlag = "--rebiu";
  if (missing.length > 0 && !argv.includes(rebiuFlag)) {
    console.log("RE-BIU-ING...\n");
    const proc = Bun.spawn([execPath, ...argv.slice(2), rebiuFlag], {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      detached: true,
    });
    const exitCode = await proc.exited;
    process.exit(exitCode);
  }
  return missing;
}

/**
 * 从 stdin 读取一行，返回用户是否回答 y/Y
 */
async function promptYesNo(question: string): Promise<boolean> {
  process.stdout.write(question);
  const reader = process.stdin;
  // Bun 的 stdin 支持异步迭代或直接读取一行
  for await (const chunk of reader) {
    const line = typeof chunk === "string"
      ? chunk.trim()
      : Buffer.from(chunk).toString().trim();
    return /^y(es)?$/i.test(line);
  }
  return false;
}

// ======================== 记录模式 ========================

/**
 * 将依赖记录到 JSON 文件（package.json 格式）
 * 如果文件已存在，合并到 dependencies 字段；否则新建
 */
async function recordDepsToJson(
  pkgNames: string[],
  outFile: string,
): Promise<void> {
  let pkg: Record<string, unknown> = {};
  try {
    const raw = await Bun.file(outFile).text();
    pkg = JSON.parse(raw);
  } catch {
    // 文件不存在或解析失败，从头创建
  }

  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  for (const name of pkgNames) {
    if (!deps[name]) {
      deps[name] = "*"; // 只记录依赖名，版本标记为 *
    }
  }
  pkg.dependencies = deps;
  await Bun.write(outFile, JSON.stringify(pkg, null, 2) + "\n");
}

/**
 * 将依赖记录到 TXT 文件（每行 package,version 格式）
 * 如果文件已存在，合并新条目；否则新建
 */
async function recordDepsToTxt(
  pkgNames: string[],
  outFile: string,
): Promise<void> {
  const existing = new Map<string, string>();
  try {
    const raw = await Bun.file(outFile).text();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf(",");
      if (idx > 0) {
        existing.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
      } else {
        existing.set(trimmed, "*");
      }
    }
  } catch {
    // 文件不存在
  }

  for (const name of pkgNames) {
    if (!existing.has(name)) {
      existing.set(name, "*");
    }
  }

  const lines = [...existing.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ver]) => `${name},${ver}`);
  await Bun.write(outFile, lines.join("\n") + "\n");
}
