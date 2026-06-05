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
- **Backend (API Routes)**: If a `./backend` directory exists, biu mounts it as
  a [Next.js](https://nextjs.org)-style file-system router (powered by
  `Bun.FileSystemRouter`). Each `.ts`/`.js` file under it becomes a route, and
  named exports `GET`/`POST`/`PUT`/`DELETE`/... (or a `default` handler) serve
  matching HTTP methods. Routes are hot-reloaded on file changes — no restart.
- **CDN Caching (offline-ready)**: `--cdn-cache` recursively downloads every
  CDN URL referenced from HTML / CSS / JS / TS / `<script type="importmap">` to
  a local fs cache, rewrites build outputs to load them from `<outDir>/cdn/`,
  and injects a runtime shim that intercepts dynamic
  `document.createElement('script'|'link')` / `fetch` / `XHR` cross-origin
  loads. `--offline` fails loud on cache misses; in `--serve` mode the dev
  server exposes a lazy `/_cdn/<host>/<path>` proxy that fills the cache on
  demand.
- **Dependency Management**: Auto-install, interactive confirm, or record-only
  modes for npm dependencies (`--depends`).
- **Post-build Scripts**: Run custom `.sh`/`.ts`/`.js` scripts after each build.
- **Self-compile**: Build a standalone binary with a single command.
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
├── importmaps.ts               ← <script type="importmap"> handling
├── cdn.ts                      ← CDN URL extraction, fs cache, rewrite pipeline
├── cdn-shim.ts                 ← Runtime shim injected into HTML for dynamic loads
├── builder.ts                  ← Core build logic (deps, modules, path rewriting)
├── post-build.ts               ← Post-build script execution
├── server.ts                   ← Watch mode, dev server, backend router, CDN proxy
├── *_test.ts                   ← Test files for each module
plugins/
└── minify-html-literals/       ← HTML template literal minifier (vendored)
demo-project/                   ← Example project for testing
```

### Module Dependencies (bottom-up)

| Module        | Responsibility           | Dependencies                                                |
| ------------- | ------------------------ | ----------------------------------------------------------- |
| `constants`   | Constants & config       | —                                                           |
| `utils`       | Base utilities           | —                                                           |
| `cli`        | Argument parsing         | constants                                                   |
| `styles`      | CSS processing           | utils                                                       |
| `html`        | HTML processing          | styles                                                      |
| `assets`      | Asset processing         | utils                                                       |
| `plugins`     | Build plugins            | minify-html-literals                                        |
| `post-build`  | Post-build scripts       | —                                                           |
| `importmaps`  | Importmap handling       | utils                                                       |
| `cdn-shim`    | Runtime CDN shim source  | —                                                           |
| `cdn`         | CDN cache pipeline       | utils, cdn-shim                                             |
| `server`      | Watch / Serve / Backend  | constants, utils                                            |
| `deps`        | Dependency mgmt          | cli                                                         |
| `builder`     | Core build               | utils, constants, styles, assets, plugins, html, deps, cdn  |
| **`biu.ts`**  | **Entry point**          | cli, constants, builder, assets, post-build, server, cdn    |

## Installation & Compilation

### Quick install (prebuilt binary)

If a prebuilt binary has been published to the GitHub Releases of
[`mindon/biu`](https://github.com/mindon/biu/releases), you can install it
without cloning the repo:

**macOS / Linux / WSL:**

```bash
curl -fsSL https://mindon.dev/biu/install | bash
```

**Windows (PowerShell):**

```powershell
powershell -c "irm https://mindon.dev/biu/install.ps1 | iex"
```

The installers download `biu-<target>.zip` from GitHub Releases, extract the
`biu` (or `biu.exe`) binary into `$BIU_INSTALL/bin` (default `~/.biu/bin` /
`%USERPROFILE%\.biu\bin`) and add it to your `PATH`. Supported targets:

| Target               | Asset name                    |
| -------------------- | ----------------------------- |
| `darwin-x64`         | `biu-darwin-x64.zip`          |
| `darwin-aarch64`     | `biu-darwin-aarch64.zip`      |
| `linux-x64`          | `biu-linux-x64.zip`           |
| `linux-aarch64`      | `biu-linux-aarch64.zip`       |
| `linux-x64-musl`     | `biu-linux-x64-musl.zip`      |
| `linux-aarch64-musl` | `biu-linux-aarch64-musl.zip`  |
| `windows-x64`        | `biu-windows-x64.zip`         |

> Each zip ships the `biu` binary plus `USAGE.md`. Linux musl variants are
> auto-detected (Alpine, etc.). Windows ARM64 falls back to `windows-x64`
> under emulation since Bun does not yet provide a native ARM64 build.

Override defaults via env vars: `BIU_INSTALL` (install root) or `GITHUB`
(GitHub origin, useful for proxy mirrors).

Releases are produced by the [`Release` GitHub Actions workflow](.github/workflows/release.yml)
on every `v*` tag — push a tag to trigger it:

```bash
git tag v1.1.9
git push origin v1.1.9
```

### Build from source

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

> If a `./backend` directory exists, biu treats it as a Next.js-style
> file-system router (see [Backend (API Routes)](#backend-api-routes)).

### Command Syntax

```bash
biu [src-dir] [out-dir] [--watch] [--static dir] [--serve port] \
    [--depends mode] [--post-build file] [--build outfile] [--force] \
    [--backend-dir dir] [--backend-style nextjs] \
    [--cdn-cache [dir]] [--offline]
```

- `src-dir`: The source directory (default: `./src`).
- `out-dir`: The output directory (default: `./dist`).
- `--watch`: Enable watch mode — rebuild on file changes.
- `--static dir`: Specify a static assets directory to copy as-is into the
  output (default: `./static`). If the directory exists, its contents are
  copied before each build. In watch mode the static directory is also
  monitored.
- `--depends [mode]`: Control how missing npm dependencies are handled (default:
  `auto`). See [Dependency Management](#dependency-management) for details.
- `--post-build <file>`: Module `.ts`/`.js` or shell script to run after each
  build. Receives the output directory as the first argument (`$1`).
- `--serve [port]`: Start a static file server for the output directory on the
  given port (default: `3000` when no port is specified). Implies `--watch`.
  Also enables the backend router (if `./backend` exists) and the CDN proxy
  (if `--cdn-cache` is set).
- `--build [outfile]`: Self-compile `biu.ts` into a standalone binary at the
  given path (default: `./biu`). Uses `bun build --compile --minify` under the
  hood.
- `--force`: Force rewrite output files even if their content hash matches an
  existing file.
- `--backend-dir <dir>`: Override the API routes directory (default:
  `./backend`). Only consulted when `--serve` is active.
- `--backend-style <style>`: File-system router style passed to
  `Bun.FileSystemRouter` (default: `nextjs`).
- `--cdn-cache [dir]`: Cache all referenced CDN URLs into a local directory
  (default: `.biu-cache/cdn`) and rewrite outputs to load them from
  `<outDir>/cdn/`. See [CDN Caching](#cdn-caching).
- `--offline`: Never hit the network — only serve from cache; warn on misses.
  Implies `--cdn-cache`.
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

**Backend API + static dev server:**

```bash
# Drop a route in ./backend/hello.ts, then:
biu --serve 3000
# → GET http://localhost:3000/hello
```

**Cache CDN deps for offline use:**

```bash
biu --cdn-cache             # fetch + cache, rewrite outputs to ./dist/cdn/
biu --cdn-cache --offline   # build with zero network egress
biu --serve --cdn-cache     # dev server with lazy /_cdn/<host>/<path> proxy
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
- API routes from `./backend` (or `--backend-dir`) are mounted in front of
  static files (see [Backend (API Routes)](#backend-api-routes)).
- When `--cdn-cache` is active, a lazy proxy at `/_cdn/<host>/<path>`
  populates the cache on demand (see [CDN Caching](#cdn-caching)).

## Backend (API Routes)

If a `./backend` directory exists (or `--backend-dir <dir>` is provided), biu
enables an integrated API layer powered by `Bun.FileSystemRouter`. It only
runs when `--serve` is active — pure static builds are unaffected.

**File layout:**

```
backend/
├── index.ts             → GET  /
├── hello.ts             → GET  /hello
├── users/
│   ├── index.ts         → GET  /users
│   └── [id].ts          → GET  /users/:id   (params.id)
└── api/
    └── search.ts        → GET  /api/search  (?q=...)
```

**Handler shape:** each route file may export named methods (`GET`, `POST`,
`PUT`, `PATCH`, `DELETE`, ...) and/or a `default` function. Named methods
take precedence; `default` is the catch-all fallback. Anything else returns
`405 Method Not Allowed`.

```typescript
// backend/users/[id].ts
import type { RouteContext } from "biu/server";

export async function GET(req: Request, ctx: RouteContext) {
  return { id: ctx.params.id, name: "Ada" };
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  return new Response(null, { status: 204 });
}
```

**Return value coercion:** handlers may return any of:

| Returned value                              | Response                                |
| ------------------------------------------- | --------------------------------------- |
| `Response`                                  | passed through                          |
| `string`                                    | `text/plain; charset=utf-8`             |
| `null` / `undefined`                        | `204 No Content`                        |
| `ArrayBuffer` / `Uint8Array` / `Blob` / `ReadableStream` | binary stream                |
| anything else (object/array/number/...)     | JSON (`application/json; charset=utf-8`)|

Errors thrown inside a handler are logged and surface as `500`.

**`RouteContext`:**

```typescript
interface RouteContext {
  params: Record<string, string>;   // dynamic segments, e.g. /users/[id]
  query: Record<string, string>;    // parsed query string
  pathname: string;                 // matched route pathname
}
```

**Hot reload:** the backend directory is watched recursively. Edits invalidate
the route module cache (via a `?v=<n>` import suffix) and the next request
re-imports the latest version — no server restart, no debounce flicker.

```bash
# Defaults: ./backend, nextjs style
biu --serve 3000

# Custom location
biu --serve 3000 --backend-dir ./api
```

## CDN Caching

`--cdn-cache` lets you ship a build that works fully offline by mirroring
every external CDN dependency into a local directory. It is opt-in — without
the flag biu ignores remote URLs.

**What is discovered:**

- HTML attributes: `<script src>`, `<link href>`, `<img src>`, `<iframe src>`,
  `<video src>`, `<source src>`, `data-src`, etc.
- `<script type="importmap">` JSON entries (recursively).
- CSS: `url(https://...)` and `@import "https://..."`.
- JS/TS: `import ... from "https://..."`, bare `import "..."`, dynamic
  `import("...")`, `new URL("https://...")`, plus conservative literal-URL
  detection for runtime loaders (covers
  `s.src = "https://cdn/foo.js"` style code).
- Recursive walk: each fetched JS/CSS body is scanned for further CDN URLs
  (and relative paths inside CDN packages) until the closure is complete.

**What happens at build time:**

1. URLs are downloaded into `<cacheDir>/<host>/<path>`
   (default `cacheDir`: `.biu-cache/cdn`, persistent across builds).
2. A manifest (`manifest.json`) is written next to the cache so subsequent
   builds reuse it even if the network is unavailable.
3. JS/CSS bodies inside the cache are rewritten to refer to their cache
   siblings via relative paths — the cache directory is fully self-contained.
4. The cache is mirrored into `<outDir>/cdn/`.
5. All HTML / CSS / JS in `<outDir>` are rewritten so the original CDN URLs
   point at `./cdn/<host>/<path>`.
6. A tiny runtime shim (`<script data-biu-cdn>`) is injected into every HTML
   that intercepts dynamic `document.createElement('script'|'link')`,
   `fetch()`, and `XMLHttpRequest` calls and redirects known CDN URLs to the
   local copy. Unknown URLs fall back to the network — or, in `--serve` mode,
   to the dev-server proxy at `/_cdn/<host>/<path>`.

**Dev-server proxy:** while `biu --serve` is running with `--cdn-cache`, any
request to `/_cdn/<host>/<path>` is served from cache; on a miss it fetches
upstream, writes to cache, and serves the body. With `--offline` the proxy
returns `504` instead of touching the network.

**Examples:**

```bash
# Default cache dir (.biu-cache/cdn) — fetch on first build, cache on subsequent
biu --cdn-cache

# Custom cache dir
biu --cdn-cache ./vendor-cdn

# Build for production with no network at all (CI without egress, air-gapped, etc.)
biu --cdn-cache --offline

# Dev server with on-demand proxy filling
biu --serve 3000 --cdn-cache
```

After the build, `<outDir>/cdn/` is fully self-contained and can be deployed
along with the rest of the site — your users never hit the upstream CDN.

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
