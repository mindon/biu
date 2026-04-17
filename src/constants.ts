// biu — constants & extension sets

export const VERSION = "biu v1.0.1 (2026.0417, https://mindon.dev)";

export const USAGE = `
Usage: biu [options] [srcDir] [outDir]

Options:
  --watch              Watch mode
  --static <dir>       Static directory (default: ./static)
  --post-build <file>  Run .sh/.ts/.js script after build (receives outDir as $1)
  --serve [port]       Serve static files (default port: 3000)
  --build [outfile]    Self-compile to binary (default: ./biu)
  -v, --version        Show version
  -h, --help           Show help
`;

/** 已由其他步骤处理的文件扩展名（JS/TS/HTML/CSS/SCSS 等） */
export const MANAGED_EXTS = new Set([
  ".ts",
  ".js",
  ".mts",
  ".mjs",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
]);

/** 常见的 HTML 静态资源扩展名 */
export const ASSET_EXTS = new Set([
  // 图片
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  // 字体
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // 音视频
  ".mp3",
  ".ogg",
  ".wav",
  ".mp4",
  ".webm",
  ".ogv",
  // 其他
  ".json",
  ".xml",
  ".csv",
  ".tsv",
  ".txt",
  ".pdf",
  ".wasm",
  ".map",
]);

// 通过环境变量 BIU_ASSET_EXTS 增加更多静态资源扩展名
// 格式：逗号或空格分隔，扩展名可带或不带点号前缀
// 例如：BIU_ASSET_EXTS="glb,gltf,hdr"
if (process.env.BIU_ASSETS_EXTS) {
  for (
    const raw of process.env.BIU_ASSET_EXTS?.split(/[\s,;]+/).filter(Boolean)
  ) {
    const ext = raw.startsWith(".")
      ? raw.toLowerCase()
      : `.${raw.toLowerCase()}`;
    ASSET_EXTS.add(ext);
  }
}

export const excludedRules = (() => {
  const rules = process.env.BIU_EXCLUDED;
  if (!rules) return;
  try {
    return new RegExp(rules, "i");
  } catch (err) {
    console.error(err);
  }
})();
