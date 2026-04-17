# biu — Usage Guide

A zero-config, high-performance bundler for HTML + TypeScript/JavaScript,
powered by [Bun](https://bun.sh/).

## Quick Start

```bash
# Place `biu` in your PATH, then from any project directory:
biu                        # Build ./src → ./dist
biu ./src ./dist           # Explicit source & output dirs
biu --serve 3000           # Dev server with live reload
```

## Command Syntax

```
biu [options] [srcDir] [outDir]
```

| Argument | Default  | Description      |
| -------- | -------- | ---------------- |
| `srcDir` | `./src`  | Source directory |
| `outDir` | `./dist` | Output directory |

## Options

| Option                | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `--watch`             | Watch mode — rebuild on file changes                       |
| `--static <dir>`      | Static assets directory (default: `./static`)              |
| `--post-build <file>` | Run `.sh`/`.ts`/`.js` script after each build              |
| `--serve [port]`      | Start dev server (default port: `3000`, implies `--watch`) |
| `--build [outfile]`   | Self-compile to standalone binary (default: `./biu`)       |
| `-v, --version`       | Show version                                               |
| `-h, --help`          | Show help                                                  |

Options can appear in any order.

## Examples

**Basic build:**

```bash
biu ./src ./dist
```

**Watch mode with dev server:**

```bash
biu --serve 8080
```

**Custom static directory + post-build script:**

```bash
biu --static ./public --post-build ./scripts/deploy.sh
```

## Smart Module Splitting

- **Independent module**: If a `.ts`/`.js` file's basename (e.g. `main.ts`)
  appears in any HTML file, it's built as a separate module with content hash.
- **Auto inline**: If the basename never appears in any HTML, the file is
  automatically inlined into its importer — no separate output.
- **Force inline (`??`)**: Append `??` to force inline bundling:
  ```typescript
  import { myUtil } from "./utils.ts??";
  ```

## Environment Variables

| Variable          | Description                                         |
| ----------------- | --------------------------------------------------- |
| `BIU_ASSETS_EXTS` | Extra asset extensions, e.g. `"glb,gltf,hdr"`       |
| `BIU_EXCLUDED`    | Regex pattern to exclude files, e.g. `"test\|spec"` |

## More Information

Full documentation: <https://github.com/mindon/biu>

License: MIT — <https://github.com/mindon/biu/blob/master/LICENSE>
