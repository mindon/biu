// biu — CLI argument parsing

import { resolve } from "node:path";
import { USAGE, VERSION } from "./constants.ts";

/**
 * --depends 模式：
 *  - "auto"          : 自动检测并安装缺失依赖（缺省值）
 *  - "package.json"  : 记录到 package.json（不安装），等价于 --depends=json
 *  - "<file>.json"   : 记录到指定 json 文件（package.json 格式，不安装）
 *  - "<file>.txt"    : 记录到指定 txt 文件（每行 package,version 格式，不安装）
 */
export type DependsMode =
  | { kind: "auto" }
  | { kind: "confirm" }
  | { kind: "json"; file: string }
  | { kind: "txt"; file: string };

export interface CliArgs {
  srcDir: string;
  outDir: string;
  isWatch: boolean;
  staticDir: string | null;
  servePort: number | null;
  postBuildScript?: string;
  depends: DependsMode;
  forceWrite: boolean;
  biu?: string;
  version?: string;
  usage?: string;
  backendDir?: string;
  backendStyle?: string;
}

/** 解析命令行参数 */
export function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  if (args.length === 1) {
    if (/^(-v|(--)?version)$/i.test(args[0])) {
      return { version: VERSION } as CliArgs;
    }
    if (/^(-h|(--)?(usage|help))$/i.test(args[0])) {
      return { version: VERSION, usage: USAGE } as CliArgs;
    }
  }
  let srcDir = "./src";
  let outDir = "./dist";
  let backendDir = "";
  let backendStyle = "nextjs";
  let isWatch = false;
  let staticDir: string | null = "./static"; // 缺省值
  let servePort: number | null = null;
  let postBuildScript: string | undefined;
  let depends: DependsMode = { kind: "auto" };
  let forceWrite = false;

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // 处理 --depends / --depends=value / --depends value
    if (arg === "--depends" || arg.startsWith("--depends=")) {
      const val = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : args[++i] ?? "auto";
      depends = parseDependsValue(val);
      continue;
    }

    switch (arg) {
      case "--watch":
        isWatch = true;
        break;
      case "--force":
        forceWrite = true;
        break;
      case "--static":
        staticDir = args[++i] ?? "./static";
        break;
      case "--post-build":
        postBuildScript = args[++i];
        break;
      case "--backend-dir":
        backendDir = args[++i];
        break;
      case "--backend-style":
        backendStyle = args[++i] ?? "nextjs";
        break;
      case "--serve": {
        const next = args[i + 1];
        servePort = next && !next.startsWith("-")
          ? (i++, parseInt(next, 10))
          : 3000;
        isWatch = true; // --serve 隐含 watch 模式
        break;
      }
      case "--build": {
        const next = args[i + 1];
        return {
          biu: next && !next.startsWith("-") ? (i++, next) : "./bin/biu",
        } as CliArgs;
      }
      default:
        if (!arg.startsWith("-")) positional.push(arg);
        break;
    }
  }

  if (positional.length >= 1) srcDir = positional[0];
  if (positional.length >= 2) outDir = positional[1];

  return {
    srcDir: resolve(srcDir),
    outDir: resolve(outDir),
    isWatch,
    staticDir: staticDir ? resolve(staticDir) : null,
    servePort,
    postBuildScript,
    depends,
    forceWrite,
    backendDir,
    backendStyle,
  };
}

/** 解析 --depends 的值 */
function parseDependsValue(val: string): DependsMode {
  if (!val || val === "auto") return { kind: "auto" };
  if (val === "confirm") return { kind: "confirm" };
  // --depends=json 等价于 --depends=package.json
  if (val === "json") return { kind: "json", file: "package.json" };
  if (val.endsWith(".json")) return { kind: "json", file: val };
  if (val.endsWith(".txt")) return { kind: "txt", file: val };
  // 其他未识别的值当做 auto
  return { kind: "auto" };
}
