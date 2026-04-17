// biu — CLI argument parsing

import { resolve } from "node:path";
import { USAGE, VERSION } from "./constants.ts";

export interface CliArgs {
  srcDir: string;
  outDir: string;
  isWatch: boolean;
  staticDir: string | null;
  servePort: number | null;
  postBuildScript?: string;
  biu?: string;
  version?: string;
  usage?: string;
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
  let isWatch = false;
  let staticDir: string | null = "./static"; // 缺省值
  let servePort: number | null = null;
  let postBuildScript: string | undefined;

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--watch":
        isWatch = true;
        break;
      case "--static":
        staticDir = args[++i] ?? "./static";
        break;
      case "--post-build":
        postBuildScript = args[++i];
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
        if (!args[i].startsWith("-")) positional.push(args[i]);
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
  };
}
