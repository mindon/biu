// biu — auto-detect and install missing npm dependencies

import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { DependsMode } from "./cli.ts";

const CACHE_FILE = ".biu-deps";

/** import/require 模式 */
const IMPORT_PATTERNS: RegExp[] = [
  // ESM: from "pkg"（覆盖 import {...} from / export {...} from / export * from）
  /\bfrom\s*["']([^"']+)["']/g,
  // ESM side-effect: import "pkg"（仅 import 后直接跟字符串，无绑定）
  /\bimport\s*["']([^"']+)["']/g,
  // CJS: require("pkg") — 仅单参数形式（右括号紧跟引号后）
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/**
 * 从代码中提取所有 import specifier（原始值）
 * 仅做语法层面的快速过滤（协议/相对路径/绝对路径/URL）
 */
function extractImportSpecs(code: string): Set<string> {
  const specs = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    // 每次使用需要重置 lastIndex（或重新创建），这里用 matchAll 更安全
    for (const m of code.matchAll(pattern)) {
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

/** 从 specifier 提取 npm 包名（@scope/pkg 或 pkg） */
function specToPackageName(spec: string): string {
  const parts = spec.split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
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
  const h = createHash("sha256");
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
    return (await readFile(join(installDir, CACHE_FILE), "utf8")).trim();
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
  await writeFile(join(installDir, CACHE_FILE), hash + "\n");
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
): Promise<string[]> {
  const pkgRoot = findPackageRoot(srcDir);
  const installDir = pkgRoot || dirname(srcDir);

  // 并行读取所有 JS/TS 文件，提取 npm 包引用
  const allPkgs = new Set<string>();
  await Promise.all(
    jsFiles.map(async (file) => {
      const code = await readFile(file, "utf8");
      const dir = dirname(file);
      for (const spec of extractImportSpecs(code)) {
        // 检查 spec 是否指向本地文件（相对于当前文件目录解析）
        const localPath = join(dir, spec);
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
    const raw = await readFile(outFile, "utf8");
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
  await writeFile(outFile, JSON.stringify(pkg, null, 2) + "\n");
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
    const raw = await readFile(outFile, "utf8");
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
  await writeFile(outFile, lines.join("\n") + "\n");
}
