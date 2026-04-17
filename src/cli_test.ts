import { beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { USAGE, VERSION } from "./constants.ts";
import { parseArgs } from "./cli.ts";

// Helper: temporarily override process.argv and restore after
function withArgs(args: string[], fn: () => void) {
  const original = process.argv;
  process.argv = ["bun", "biu.ts", ...args];
  try {
    fn();
  } finally {
    process.argv = original;
  }
}

describe("parseArgs", () => {
  test("default values (no args)", () => {
    withArgs([], () => {
      const result = parseArgs();
      expect(result.srcDir).toBe(resolve("./src"));
      expect(result.outDir).toBe(resolve("./dist"));
      expect(result.isWatch).toBe(false);
      expect(result.staticDir).toBe(resolve("./static"));
      expect(result.servePort).toBeNull();
      expect(result.postBuildScript).toBeUndefined();
    });
  });

  test("-v returns version", () => {
    withArgs(["-v"], () => {
      const result = parseArgs();
      expect(result.version).toBe(VERSION);
    });
  });

  test("--version returns version", () => {
    withArgs(["--version"], () => {
      const result = parseArgs();
      expect(result.version).toBe(VERSION);
    });
  });

  test("-h returns version and usage", () => {
    withArgs(["-h"], () => {
      const result = parseArgs();
      expect(result.version).toBe(VERSION);
      expect(result.usage).toBe(USAGE);
    });
  });

  test("--help returns version and usage", () => {
    withArgs(["--help"], () => {
      const result = parseArgs();
      expect(result.version).toBe(VERSION);
      expect(result.usage).toBe(USAGE);
    });
  });

  test("positional srcDir and outDir", () => {
    withArgs(["./my-src", "./my-out"], () => {
      const result = parseArgs();
      expect(result.srcDir).toBe(resolve("./my-src"));
      expect(result.outDir).toBe(resolve("./my-out"));
    });
  });

  test("--watch enables watch mode", () => {
    withArgs(["--watch"], () => {
      const result = parseArgs();
      expect(result.isWatch).toBe(true);
    });
  });

  test("--static sets static directory", () => {
    withArgs(["--static", "./public"], () => {
      const result = parseArgs();
      expect(result.staticDir).toBe(resolve("./public"));
    });
  });

  test("--serve with port", () => {
    withArgs(["--serve", "8080"], () => {
      const result = parseArgs();
      expect(result.servePort).toBe(8080);
      expect(result.isWatch).toBe(true); // serve implies watch
    });
  });

  test("--serve without port defaults to 3000", () => {
    withArgs(["--serve"], () => {
      const result = parseArgs();
      expect(result.servePort).toBe(3000);
      expect(result.isWatch).toBe(true);
    });
  });

  test("--serve before another flag defaults to 3000", () => {
    withArgs(["--serve", "--watch"], () => {
      const result = parseArgs();
      expect(result.servePort).toBe(3000);
      expect(result.isWatch).toBe(true);
    });
  });

  test("--build with output path", () => {
    withArgs(["--build", "./bin/biu"], () => {
      const result = parseArgs();
      expect(result.biu).toBe("./bin/biu");
    });
  });

  test("--build without path defaults to ./bin/biu", () => {
    withArgs(["--build"], () => {
      const result = parseArgs();
      expect(result.biu).toBe("./bin/biu");
    });
  });

  test("--post-build sets script path", () => {
    withArgs(["--post-build", "./scripts/post.sh"], () => {
      const result = parseArgs();
      expect(result.postBuildScript).toBe("./scripts/post.sh");
    });
  });

  test("combined options", () => {
    withArgs([
      "./app",
      "./build",
      "--watch",
      "--static",
      "./assets",
      "--serve",
      "4000",
    ], () => {
      const result = parseArgs();
      expect(result.srcDir).toBe(resolve("./app"));
      expect(result.outDir).toBe(resolve("./build"));
      expect(result.isWatch).toBe(true);
      expect(result.staticDir).toBe(resolve("./assets"));
      expect(result.servePort).toBe(4000);
    });
  });
});
