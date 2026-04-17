# biu

`biu` is a zero-config, high-performance bundler for HTML files with
TypeScript/JavaScript, powered by [Bun](https://bun.sh/). It handles module
splitting with custom import suffixes and provides built-in minification for
HTML, CSS, and JS.

## Features

- **Zero-config**: Automatically scans and bundles your project.
- **Smart Module Splitting**: TS/JS files whose basename appears in any HTML are
  built as independent modules; others are automatically inlined.
- **Force Inline (`??`)**: Use the `??` import suffix to force inline bundling.
- **Minification**: Built-in minification for HTML, CSS/SCSS, and
  TypeScript/JavaScript (including HTML template literals).
- **Content Hashing**: Output filenames include content hash for cache busting.
- **Static Directory**: Copy unprocessed static assets directly to the output.
- **Watch Mode**: Live rebuilds on file changes with debounce.
- **Dev Server**: Built-in static file server with SPA fallback.
- **Post-build Scripts**: Run custom `.sh`/`.ts`/`.js` scripts after each build.
- **Self-compile**: Build a standalone binary with a single command.
- **Fast**: Built on the lightning-fast Bun runtime.

## Project Structure

```
biu.ts                          ← Main entry (~95 lines), orchestrates all modules
src/
├── constants.ts                ← Version, USAGE, extension sets, env vars
├── utils.ts                    ← Utilities (contentHash, recursive scan)
├── cli.ts                      ← CLI argument parsing
├── styles.ts                   ← CSS/SCSS compilation & minification
├── assets.ts                   ← Static asset processing & copying
├── plugins.ts                  ← Bun build plugins (base + main)
├── html.ts                     ← HTML processing & minification
├── builder.ts                  ← Core build logic (deps, modules, path rewriting)
├── post-build.ts               ← Post-build script execution
├── server.ts                   ← Watch mode & dev server
├── *_test.ts                   ← Test files for each module
plugins/
└── minify-html-literals/       ← HTML template literal minifier (vendored)
demo-project/                   ← Example project for testing
```

### Module Dependencies (bottom-up)

| Module       | Responsibility     | Dependencies                                        |
| ------------ | ------------------ | --------------------------------------------------- |
| `constants`  | Constants & config | —                                                   |
| `utils`      | Base utilities     | —                                                   |
| `cli`        | Argument parsing   | constants                                           |
| `styles`     | CSS processing     | utils                                               |
| `html`       | HTML processing    | styles                                              |
| `assets`     | Asset processing   | utils                                               |
| `plugins`    | Build plugins      | minify-html-literals                                |
| `post-build` | Post-build scripts | —                                                   |
| `server`     | Watch / Serve      | constants                                           |
| `builder`    | Core build         | utils, constants, styles, assets, plugins, html     |
| **`biu.ts`** | **Entry point**    | cli, constants, builder, assets, post-build, server |

## Installation & Compilation

Since `biu` is built with Bun, you can compile it into a single executable
binary for portability.

1. Ensure you have [Bun](https://bun.sh/) installed.
2. Clone the repository and navigate to the directory.
3. Prepare dependencies: `bun i`
4. Compile with the built-in `--build` command:

```bash
# Self-compile to ./bin/biu (default)
bun run biu.ts --build

# Specify output path
bun run biu.ts --build ./bin/biu
bun run biu.ts --build /usr/local/bin/biu
```

Bun's auto-install will fetch any missing dependencies automatically. The
resulting binary is fully standalone.

## Usage

Run the `biu` binary or use `bun run` directly.

### Command Syntax

```bash
biu [src-dir] [out-dir] [--watch] [--static dir] [--serve port] [--post-build file] [--build outfile]
```

- `src-dir`: The source directory (default: `./src`).
- `out-dir`: The output directory (default: `./dist`).
- `--watch`: Enable watch mode — rebuild on file changes.
- `--static dir`: Specify a static assets directory to copy as-is into the
  output (default: `./static`). If the directory exists, its contents are copied
  before each build. In watch mode the static directory is also monitored.
- `--post-build <file>`: Module `.ts`/`.js` or shell script to run after each
  build. Receives the output directory as the first argument (`$1`).
- `--serve [port]`: Start a static file server for the output directory on the
  given port (default: `3000` when no port is specified). Implies `--watch`.
- `--build [outfile]`: Self-compile `biu.ts` into a standalone binary at the
  given path (default: `./biu`). Uses `bun build --compile --minify` under the
  hood.
- `-v, --version`: Show version info.
- `-h, --help`: Show help / usage.

Options can appear in any order.

### Examples

**Basic build:**

```bash
cd demo-project
biu ./src ./dist
```

**Watch mode:**

```bash
biu --watch
```

**Dev server on port 8080:**

```bash
biu --serve 8080
```

**Custom static directory + dev server:**

```bash
biu ./src ./dist --static ./public --serve 4000
```

**Post-build script:**

```bash
biu --post-build ./scripts/deploy.sh
```

**Compile to binary and run:**

```bash
# From the biu repo
bun run biu.ts --build bin/biu
export PATH=$PATH:`pwd`/bin

# From a project directory
cd demo-project
biu --serve 3000
```

**Install globally:**

```bash
bun run biu.ts --build /usr/local/bin/biu

cd demo-project
biu --serve 3000
```

## Advanced Imports

`biu` supports smart module splitting based on basename visibility in HTML:

- **Independent module**: If a `.ts`/`.js` file's **basename** (e.g. `main.ts`)
  appears anywhere in any HTML file's content, it is built as an **independent
  module** with its own hashed output file.
- **Auto inline**: If the basename never appears in any HTML, and the file is
  imported by another `.ts`/`.js`, it is **automatically inlined** into its
  importer — no separate output file is generated.
- **Force inline (`??`)**: Use the `??` suffix to force a module to be bundled
  inline regardless of whether its basename appears in HTML:
  ```typescript
  import { myUtil } from "./utils.ts??";
  ```

This means you typically don't need to think about bundling strategy — files
mentioned in HTML get their own output, and pure helper/utility modules are
automatically bundled into the files that use them.

## Static Directory

Files under the static directory (default `./static`) are copied verbatim into
the output directory **before** the build runs. This is useful for assets that
should not be processed or hashed — e.g. `robots.txt`, `manifest.json`,
third-party scripts, etc.

```bash
# Use the default ./static directory
biu

# Specify a different directory
biu --static ./public
```

## Dev Server

`--serve` starts a lightweight HTTP server powered by `Bun.serve` that serves
the output directory:

- `/` maps to `/index.html`.
- Requests without a file extension fall back to `/index.html` (SPA-friendly).
- Proper MIME types are automatically detected by Bun.
- `--serve` automatically enables watch mode, so changes trigger a rebuild.

## Environment Variables

### `BIU_ASSETS_EXTS`

Add extra static asset extensions beyond the built-in set (images, fonts, audio,
video, etc.). Extensions can be specified with or without a leading dot,
separated by commas, spaces, or semicolons.

```bash
BIU_ASSETS_EXTS=".glb .gltf .hdr" biu
BIU_ASSETS_EXTS="glb,gltf,hdr" biu
```

### `BIU_EXCLUDED`

A regex pattern to exclude files from processing. Case-insensitive.

```bash
BIU_EXCLUDED="test|spec" biu
```

## Testing

Tests are written with Bun's built-in test runner. Each module in `src/` has a
corresponding `*_test.ts` file.

```bash
# Run all tests
bun test src/

# Run a specific test file
bun test src/html_test.ts
```

## License

MIT
