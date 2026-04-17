// biu, a bundler for htmls with typescript, run with bun
// self-compile: bun run biu.ts --build ./bin/biu
// export PATH=$PATH:`pwd`/bin
// usage: biu [src-dir] [out-dir] [--watch] [--static dir] [--serve port]
// use ?? to force import ts/js inline, e.g. import {my} from "my.ts??";

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { VERSION } from "./src/constants.ts";
import { parseArgs } from "./src/cli.ts";
import { buildProject } from "./src/builder.ts";
import { copyStaticDir } from "./src/assets.ts";
import { postBuild } from "./src/post-build.ts";
import { startDevServer, startWatcher } from "./src/server.ts";

const cwd = process.cwd();

async function run() {
  const {
    srcDir,
    outDir,
    isWatch,
    staticDir,
    servePort,
    biu,
    version,
    usage,
    postBuildScript,
  } = parseArgs();

  if (version) {
    console.log(version);
    if (usage) console.log(usage);
    return;
  }
  console.log(`\n${VERSION}\n`);

  // --build 模式：自编译为独立二进制
  if (biu) {
    const outFile = resolve(biu);
    const selfPath = resolve(import.meta.dir, "biu.ts");
    if (!existsSync(selfPath)) {
      console.error(`❌ Self-build failed: ${selfPath} not found`);
      process.exit(1);
    }
    const args = [
      "bun",
      "build",
      selfPath,
      "--compile",
      "--minify",
      "--target",
      "browser",
      `--outfile=${outFile}`,
    ];
    console.log(`🔨 Self-compiling: ${args.join(" ")}`);
    const proc = Bun.spawn(args, {
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log(`✅ Binary created: ${outFile}`);
    } else {
      console.error(`❌ Build failed with exit code ${exitCode}`);
    }
    process.exit(exitCode);
  }

  console.log(`-- Working directory: ${cwd} --\n`);

  /** 执行完整构建（含静态目录复制） */
  async function fullBuild(staticMode?: string) {
    if (staticDir && existsSync(staticDir)) {
      await copyStaticDir(staticDir, outDir, cwd);
    }
    if (staticMode === "static") return;
    await buildProject(srcDir, outDir);
    await postBuild(outDir, postBuildScript);
  }

  // 首次构建
  await fullBuild();

  if (isWatch) {
    startWatcher(srcDir, staticDir, cwd, fullBuild);

    if (servePort) {
      startDevServer(outDir, servePort, cwd);
    }
  }
}

run().catch(console.error);
