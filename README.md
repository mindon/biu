# biu

`biu` is a zero-config, high-performance bundler for HTML files with
TypeScript/JavaScript, powered by [Bun](https://bun.sh/). It handles module
splitting with custom import suffixes and provides built-in minification for
HTML, CSS, and JS.

Project repository <https://github.com/mindon/biu>

Easy to use, just art run `biu --serve` within a directory with a **src/**
containing your HTML and TS/JS files, biu take care of everything else. (default
preview on <http://localhost:3000> )

The oututput directory **./dist** is all static html and JS files ready for
deployment.

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
- **Dependency Management**: Auto-install, interactive confirm, or record-only
  modes for npm dependencies (`--depends`).
- **Post-build Scripts**: Run custom `.sh`/`.ts`/`.js` scripts after each build.
- **Self-compile**: Build a standalone binary with a single command.
- **CDN Caching (offline)**: `--cdn-cache` recursively downloads every CDN URL
  referenced from HTML/CSS/JS/importmap (incl. dynamic `script.src` loads) to a
  local fs cache, rewrites build outputs to load from `<outDir>/cdn/`, and
  injects a runtime shim that intercepts dynamic `createElement` / `fetch` / XHR
  cross-origin loads. Use `--offline` to fail loudly on cache misses. In
  `--serve` mode the dev server exposes a lazy `/_cdn/<host>/<path>` proxy.
- **Fast**: Built on the lightning-fast Bun runtime.

## Project Structure

```
biu.ts                          ← Main entry (~95 lines), orchestrates all modules
src/
├── constants.ts                ← Version, USAGE, extension sets, env vars
├── utils.ts                    ← Utilities (contentHash, recursive scan)
├── cli.ts                      ← CLI argument parsing & DependsMode types
├── deps.ts                     ← Dependency detection, install & record
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

| Module       | Responsibility     | Dependencies                                          |
| ------------ | ------------------ | ----------------------------------------------------- |
| `constants`  | Constants & config | —                                                     |
| `utils`      | Base utilities     | —                                                     |
| `cli`        | Argument parsing   | constants                                             |
| `styles`     | CSS processing     | utils                                                 |
| `html`       | HTML processing    | styles                                                |
| `assets`     | Asset processing   | utils                                                 |
| `plugins`    | Build plugins      | minify-html-literals                                  |
| `post-build` | Post-build scripts | —                                                     |
| `server`     | Watch / Serve      | constants                                             |
| `deps`       | Dependency mgmt    | cli                                                   |
| `builder`    | Core build         | utils, constants, styles, assets, plugins, html, deps |
| **`biu.ts`** | **Entry point**    | cli, constants, builder, assets, post-build, server   |

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
bun run biu.ts --build /usr/local/bin/
```

Bun's auto-install will fetch any missing dependencies automatically. The
resulting binary is fully standalone.

## Usage

Run the `biu` binary or use `bun run` directly.

_Note: if there's a **./backend** directory, it will be used as
[Next.js](https://nextjs.org) style backend._

### Command Syntax

```bash
biu [src-dir] [out-dir] [--watch] [--static dir] [--serve port] [--depends mode] [--post-build file] [--build outfile]
```

- `src-dir`: The source directory (default: `./src`).
- `out-dir`: The output directory (default: `./dist`).
- `--watch`: Enable watch mode — rebuild on file changes.
- `--static dir`: Specify a static assets directory to copy as-is into the
  output (default: `./static`). If the directory exists, its contents are copied
  before each build. In watch mode the static directory is also monitored.
- `--depends [mode]`: Control how missing npm dependencies are handled (default:
  `auto`). See [Dependency Management](#dependency-management) for details.
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
biu # Equivalent to default ./src and ./dist directories
# biu ./src ./dist
```

**Watch mode:**

```bash
biu --watch
```

**Dev watch and server on port 8080:**

```bash
# biu --serve # default using 3000
biu --serve 8080
```

**Custom static directory + dev server:**

```bash
biu --static ./public --serve 4000
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

## Dependency Management

`biu` automatically scans your source files for `import`/`require` statements
and detects referenced npm packages. The `--depends` option controls what
happens next:

| Mode               | Flag                        | Behavior                                                                             |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------ |
| **auto** (default) | `--depends=auto` or omitted | Detect missing packages and install them via `bun add`                               |
| **confirm**        | `--depends=confirm`         | List missing packages, prompt `y/n`; **y** installs, **n** records to `package.json` |
| **json**           | `--depends=json`            | Record all detected deps to `package.json` (no install)                              |
| **custom json**    | `--depends=my-deps.json`    | Record to a custom `.json` file in `package.json` format                             |
| **txt**            | `--depends=deps.txt`        | Record to a `.txt` file, one `package,version` per line                              |

### Examples

```bash
# Auto-install (default)
biu src dist

# Interactive confirm before installing
biu src dist --depends=confirm

# Record to package.json only
biu src dist --depends=json

# Record to a custom JSON file
biu src dist --depends=my-deps.json

# Record to a text file
biu src dist --depends=deps.txt
```

In **json** and **txt** modes, existing files are merged — new entries are added
without overwriting previously recorded dependencies.

In **confirm** mode the prompt looks like:

```
📦 Missing dependencies detected:
   • dayjs
   • lodash-es

   install dir: /path/to/project
Install these dependencies? (y/n):
```

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
