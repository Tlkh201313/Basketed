import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState } from "./state.js";

describe("profile state.json", () => {
  it("is unknown before anything was written, and remembers what was", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "basketed-state-")), "tsc_tesco");
    expect(readState(dir)).toEqual({ session_state: "unknown", last_verified_at: null, reason: null, profile: false });
    const written = writeState(dir, { session_state: "live", last_verified_at: 1234, reason: "sealed" });
    expect(written.profile).toBe(true);
    expect(readState(dir)).toEqual({ session_state: "live", last_verified_at: 1234, reason: "sealed", profile: true });
  });

  it("never reports a stale 'checking' from disk", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "basketed-state-")), "x");
    writeState(dir, { session_state: "checking", last_verified_at: null, reason: null });
    expect(readState(dir).session_state).toBe("unknown");
  });
});
