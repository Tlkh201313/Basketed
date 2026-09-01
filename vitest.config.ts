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
  },
});
