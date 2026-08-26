import { describe, expect, test } from "bun:test";
import { createRebuildScheduler } from "./server.ts";

describe("createRebuildScheduler", () => {
  test("runs a follow-up build for changes received during a build", async () => {
    const calls: Array<[string | undefined, string | undefined]> = [];
    let startFirst!: () => void;
    let finishFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve;
    });
    const firstFinished = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const scheduler = createRebuildScheduler(async (filename, staticMode) => {
      calls.push([filename, staticMode]);
      if (calls.length === 1) {
        startFirst();
        await firstFinished;
      }
    }, 0);

    scheduler.enqueue("first.ts");
    await firstStarted;
    scheduler.enqueue("second.css", "static");
    finishFirst();
    await scheduler.whenIdle();

    expect(calls).toEqual([
      ["first.ts", undefined],
      ["second.css", "static"],
    ]);
  });
});
