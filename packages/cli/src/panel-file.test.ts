import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishPanel, readPanel, clearPanel } from "./panel-file.js";

/**
 * Where the running panel is, on disk, so nothing has to guess.
 *
 * The panel takes whatever port is free -- 8787 is a popular number and the
 * server is started by whichever client launches first -- so the URL printed
 * in the docs is right about as often as it is wrong. Anything that wants to
 * reach the live panel (doctor, another CLI, a human opening a tab) reads this
 * instead of assuming.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "basketed-panel-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the live-panel handoff file", () => {
  it("round-trips the URL of the panel that is actually running", () => {
    publishPanel({ origin: "http://127.0.0.1:61817", pid: process.pid, dir });
    const live = readPanel(dir);
    expect(live?.origin).toBe("http://127.0.0.1:61817");
    expect(live?.pid).toBe(process.pid);
  });

  it("never writes the panel token into it", () => {
    publishPanel({ origin: "http://127.0.0.1:61817", pid: process.pid, dir });
    // The file is world-readable on most machines. A token in it would be a
    // credential on disk for every process on the box, which is exactly what
    // the per-process token exists to avoid.
    expect(readFileSync(join(dir, "panel.json"), "utf8")).not.toMatch(/token/i);
  });

  it("reports nothing when the process that wrote it is gone", () => {
    // A stale file from a crashed run must not send anyone to a dead port.
    publishPanel({ origin: "http://127.0.0.1:61817", pid: 999_999_999, dir });
    expect(readPanel(dir)).toBeNull();
  });

  it("reports nothing when there is no file at all", () => {
    expect(readPanel(dir)).toBeNull();
  });

  it("survives a corrupt file rather than throwing into a startup path", () => {
    writeFileSync(join(dir, "panel.json"), "{not json");
    expect(readPanel(dir)).toBeNull();
  });

  it("clears itself, and clearing twice is not an error", () => {
    publishPanel({ origin: "http://127.0.0.1:61817", pid: process.pid, dir });
    clearPanel(dir);
    expect(existsSync(join(dir, "panel.json"))).toBe(false);
    expect(() => clearPanel(dir)).not.toThrow();
  });
});
