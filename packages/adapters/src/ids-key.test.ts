import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The key that signs product ids has to outlive the process.
 *
 * It used to be minted per run, on the theory that ids are session handles.
 * They are not: an editor restarts its stdio server whenever it feels like
 * it, and every id the agent is still holding then failed to verify and read
 * as "no such product" -- with no way for anyone to tell that from a genuinely
 * unknown id.
 *
 * Run in a child process because the key is memoised for the life of a
 * module, so "a fresh start" cannot be faked inside one test run.
 */
const IDS = pathToFileURL(resolve(import.meta.dirname, "../dist/ids.js")).href;

function mintIn(stateDir: string): { id: string; parsed: unknown } {
  const script = `
    const { mintProductId, parseProductId } = await import("${IDS}");
    const id = mintProductId("amz:amazon", "B08N5WRWNW");
    process.stdout.write(JSON.stringify({ id, parsed: parseProductId(id, ["amz:amazon"]) }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, BASKETED_STATE_DIR: stateDir, BASKETED_ID_KEY: "" },
  });
  return JSON.parse(out);
}

function verifyIn(stateDir: string, id: string): unknown {
  const script = `
    const { parseProductId } = await import("${IDS}");
    process.stdout.write(JSON.stringify(parseProductId(${JSON.stringify(id)}, ["amz:amazon"])));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, BASKETED_STATE_DIR: stateDir, BASKETED_ID_KEY: "" },
    }),
  );
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "basketed-idkey-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the product-id key on disk", () => {
  it("still verifies an id minted by an earlier process", () => {
    const { id, parsed } = mintIn(dir);
    expect(parsed).toEqual({ store: "amz:amazon", nativeId: "b08n5wrwnw" });
    expect(verifyIn(dir, id)).toEqual({ store: "amz:amazon", nativeId: "b08n5wrwnw" });
  });

  it("does not verify it under a different machine's key", () => {
    const { id } = mintIn(dir);
    const other = mkdtempSync(join(tmpdir(), "basketed-idkey-other-"));
    try {
      expect(verifyIn(other, id)).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("writes the key owner-only", () => {
    mintIn(dir);
    const path = join(dir, "id.key");
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") {
      // Windows ignores POSIX mode bits; the ACL there is the file's own.
      expect(statSync(path).mode & 0o077).toBe(0);
    }
  });
});
