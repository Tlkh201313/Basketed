import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    // Redirects ~/.basketed to a temp directory for the whole run: the id key
    // and the id caches both persist there now, and a suite must not write
    // into a developer's real state or leak it between runs.
    setupFiles: ["tests/setup.ts"],
    /*
     * 5 s is not enough for the tests that do real work on a real disk.
     *
     * The vault derives an actual master key and the id-key tests write and
     * re-read real files; both are fast alone and neither is fast when the
     * whole suite runs in parallel on Windows behind a virus scanner, or
     * inside `pnpm drill`, where every worker also loads the offline guard.
     * They timed out there in a different combination on each run -- flake
     * that says nothing about the code. The tests still fail loudly if they
     * genuinely hang; they just stop failing for being on a busy machine.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
