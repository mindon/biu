// biu — post-build script runner

import { $ } from "bun";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

const cwd = process.cwd();

/** 执行构建后脚本 */
export async function postBuild(outDir: string, postBuildScript?: string) {
  if (!postBuildScript) return;
  if (!/\.(ts|js|sh)$/.test(postBuildScript)) {
    console.error(
      `❌ Only .ts/.js or .sh scripts supported for post processing: ${postBuildScript}`,
    );
    return;
  }
  try {
    const src = resolve(cwd, postBuildScript);
    if (!existsSync(src)) {
      console.error(`❌ Post-build script not found: ${src}`);
      return;
    }
    console.log("\n⚙️  Post-build processing...");
    if (/\.sh$/.test(postBuildScript)) {
      console.log(
        `  Running: sh ${relative(cwd, src)} ${relative(cwd, outDir)}`,
      );
      console.log();
      await $`sh ${src} ${outDir}`;
    } else {
      const { run: runAferBuild } = await import(src);
      console.log(`  ${relative(cwd, src)}, run = ${typeof runAferBuild}`);
      console.log();
      await runAferBuild?.(outDir);
    }
    console.info("🆗 Post build done!\n");
  } catch (err) {
    console.error("❌ Post-build error:", err);
  }
}
