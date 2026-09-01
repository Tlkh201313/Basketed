import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dirname, "bin.js");

describe("the launcher on an unbuilt checkout", () => {
  it("says to build, instead of ERR_MODULE_NOT_FOUND", () => {
    // A fresh clone, reproduced by copying only what git tracks: bin.js with
    // no dist/ beside it.
    const dir = mkdtempSync(join(tmpdir(), "basketed-unbuilt-"));
    try {
      cpSync(BIN, join(dir, "bin.js"));
      const run = spawnSync(process.execPath, [join(dir, "bin.js"), "doctor"], { encoding: "utf8" });
      expect(run.status).toBe(3);
      expect(run.stderr).toContain("has not been built yet");
      expect(run.stderr).toContain("pnpm install && pnpm build");
      expect(run.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 30s, not vitest's default 5: this spawns a second Node and loads the whole
  // CLI, which is genuinely slow on a cold cache and on a machine already
  // running the rest of the suite. It failed intermittently at 5s, and a test
  // that fails for being slow teaches everyone to re-run rather than to look.
  it("still runs normally when dist is there", () => {
    const out = execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
    expect(out).toContain("basketed serve");
  }, 30_000);
});
