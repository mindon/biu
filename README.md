# biu

`biu` is a zero-config, high-performance bundler for HTML files with
TypeScript/JavaScript, powered by [Bun](https://bun.sh/). It is designed to
handle module splitting with custom import suffixes and provides built-in
minification for HTML, CSS, and JS.

## Features

- **Zero-config**: Automatically scans and bundles your project.
- **Module Splitting**: Handle modules independently using `?module` suffixes.
- **Inline Imports**: Force inline bundling with `??` suffixes.
- **Minification**: Built-in minification for HTML, CSS, and
  TypeScript/JavaScript.
- **Watch Mode**: Live rebuilds on file changes.
- **Fast**: Built on the lightning-fast Bun runtime.

## Installation & Compilation

Since `biu` is built with Bun, you can compile it into a single executable
binary for portability.

1. Ensure you have [Bun](https://bun.sh/) installed.
2. Clone the repository and navigate to the directory.
3. Compile the project:

```bash
bun build ./biu.ts --compile --minify --outfile=biu
```

This will generate a standalone binary named `biu`.

## Usage

Run the `biu` binary or use `bun run` directly.

### Command Syntax

```bash
./biu [src-dir] [out-dir] [--watch]
```

- `src-dir`: The source directory containing your project files (default:
  `./src`).
- `out-dir`: The target directory for the production build (default: `./dist`).
- `--watch`: Enable live reload mode.

### Examples

**Basic build:**

```bash
./biu ./src ./dist
```

**Watch mode:**

```bash
./biu ./src ./dist --watch
```

## Advanced Imports

`biu` supports special suffixes to control bundling behavior:

- **Independent Module**: By default, linked `.ts` or `.js` files are treated as
  independent modules.
- **Force Inline**: Use `??` suffix to force a module to be bundled inline:
  ```typescript
  import { myModule } from "./utils.ts??";
  ```
