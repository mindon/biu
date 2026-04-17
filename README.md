# biu

`biu` is a zero-config, high-performance bundler for HTML files with
TypeScript/JavaScript, powered by [Bun](https://bun.sh/). It is designed to
handle module splitting with custom import suffixes and provides built-in
minification for HTML, CSS, and JS.

## Features

- **Zero-config**: Automatically scans and bundles your project.
- **Module Splitting**: Handle modules independently using `?module` suffixes.
- **Inline Imports**: Force inline bundling with `??` suffixes.
- **Minification**: Built-in minification for HTML, CSS/SCSS, and
  TypeScript/JavaScript (including HTML template literals).
- **Content Hashing**: Output filenames include content hash for cache busting.
- **Static Directory**: Copy unprocessed static assets directly to the output.
- **Watch Mode**: Live rebuilds on file changes with debounce.
- **Dev Server**: Built-in static file server with SPA fallback.
- **Fast**: Built on the lightning-fast Bun runtime.

## Installation & Compilation

Since `biu` is built with Bun, you can compile it into a single executable
binary for portability.

1. Ensure you have [Bun](https://bun.sh/) installed.
2. Clone the repository and navigate to the directory.
3. Prepare dependencies: `bun i # install dependencies`
4. Compile with the built-in `--build` command:

```bash
# Self-compile to ./biu (default)
bun run biu.ts --build

# Specify output path
bun run biu.ts --build ./biu
bun run biu.ts --build /usr/local/bin/biu
```

Bun's auto-install will fetch any missing dependencies automatically — no
`bun install` or `package.json` required. The resulting binary is fully
standalone.

## Usage

Run the `biu` binary or use `bun run` directly.

### Command Syntax

```bash
biu [src-dir] [out-dir] [--watch] [--static dir] [--serve port] [--build outfile]
```

- `src-dir`: The source directory (default: `./src`).
- `out-dir`: The output directory (default: `./dist`).
- `--watch`: Enable watch mode — rebuild on file changes.
- `--static dir`: Specify a static assets directory to copy as-is into the
  output (default: `./static`). If the directory exists, its contents are copied
  before each build. In watch mode the static directory is also monitored.
- `--post-build script`: module .ts/.js or shell script to run after the build
- `--serve port`: Start a static file server for the output directory on the
  given port (default: `3000` when no port is specified). Implies `--watch`.
- `--build outfile`: Self-compile `biu.ts` into a standalone binary at the given
  path (default: `./biu`). Uses `bun build --compile --minify` under the hood.

Options can appear in any order.

### Examples

**Basic build:**

```bash
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

**Compile to binary and run:**

```bash
bun run biu.ts --build ./biu
./biu --serve 3000
```

**Cross-compile or install globally:**

```bash
bun run biu.ts --build /usr/local/bin/biu
biu --serve 3000
```

## Advanced Imports

`biu` supports special suffixes to control bundling behavior:

- **Independent Module**: By default, linked `.ts` or `.js` files are treated as
  independent modules — each gets its own hashed output file.
- **Force Inline**: Use `??` suffix to force a module to be bundled inline:
  ```typescript
  import { myModule } from "./utils.ts??";
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

## License

MIT
