import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Find the directory that holds `fixtures/`.
 *
 * This is not cosmetic. An MCP client launches a stdio server with whatever
 * working directory it feels like -- Claude Code uses the project root, others
 * use the user's home -- so `process.cwd()` is not a reliable anchor for the
 * pinned store list or the simulated catalog. We walk up from this module
 * instead, which is stable whether we are running from `dist/` in the repo or
 * from inside a global npm install.
 */
export function findRoot(start?: string): string {
  const override = process.env["BASKETED_ROOT"];
  if (override && existsSync(resolve(override, "fixtures"))) return resolve(override);

  const candidates = [start ?? dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const from of candidates) {
    let dir = resolve(from);
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(resolve(dir, "fixtures", "stores.pinned.json"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}
