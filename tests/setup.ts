import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every test run gets its own state directory.
 *
 * Two things now persist under ~/.basketed: the key that signs product ids,
 * and the per-store id caches. Without this, the suite would write into the
 * developer's real state on every run -- and worse, a test that minted an id
 * would leave a key behind that changed what a LATER run of a different test
 * considered valid. Tests must not depend on each other through the home
 * directory.
 */
const dir = mkdtempSync(join(tmpdir(), "basketed-test-state-"));
process.env["BASKETED_STATE_DIR"] = dir;

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not worth failing a green run over.
  }
});
