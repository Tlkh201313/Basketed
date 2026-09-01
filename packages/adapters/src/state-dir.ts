import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Where this machine's Basketed state lives.
 *
 * One function rather than `resolve(homedir(), ".basketed")` repeated in five
 * files, because tests need to redirect it. `BASKETED_STATE_DIR` is read on
 * every call, not cached: the test setup sets it per run, and a cached value
 * would leak one suite's directory into the next.
 */
export function stateDir(): string {
  return process.env["BASKETED_STATE_DIR"] ?? resolve(homedir(), ".basketed");
}

/**
 * The state directory, created if it is missing. Returns null when it cannot
 * be created -- every caller here treats persistence as an optimisation and
 * has a working in-memory path to fall back to.
 */
export function ensureStateDir(): string | null {
  try {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}
