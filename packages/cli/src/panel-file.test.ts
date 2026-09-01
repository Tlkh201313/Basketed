import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishPanel, readPanel, clearPanel, claimPanel, releasePanel } from "./panel-file.js";

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

/**
 * Two servers on one machine is normal: a stdio panel per editor, plus an
 * HTTP one somebody started by hand. They used to fight over this file, last
 * writer winning, so every "open the panel" link pointed at whichever process
 * started most recently rather than the one a human was looking at.
 */
describe("claiming the record", () => {
  it("takes a free record", () => {
    const claim = claimPanel({ origin: "http://127.0.0.1:8788", pid: process.pid, mode: "stdio-panel", dir });
    expect(claim.claimed).toBe(true);
    expect(readPanel(dir)?.mode).toBe("stdio-panel");
  });

  it("refuses to displace a live panel of the same kind", () => {
    publishPanel({ origin: "http://127.0.0.1:8788", pid: process.pid, mode: "stdio-panel", dir });
    const claim = claimPanel({ origin: "http://127.0.0.1:9999", pid: process.pid + 1, mode: "stdio-panel", dir });
    expect(claim.claimed).toBe(false);
    expect(readPanel(dir)?.origin).toBe("http://127.0.0.1:8788");
  });

  it("lets an http panel take over from a stdio one — it also serves /mcp", () => {
    publishPanel({ origin: "http://127.0.0.1:8788", pid: process.pid, mode: "stdio-panel", dir });
    const claim = claimPanel({ origin: "http://127.0.0.1:8787", pid: process.pid + 1, mode: "http", dir });
    expect(claim.claimed).toBe(true);
    expect(readPanel(dir)?.origin).toBe("http://127.0.0.1:8787");
  });

  it("never lets a stdio panel take over from an http one", () => {
    publishPanel({ origin: "http://127.0.0.1:8787", pid: process.pid, mode: "http", dir });
    const claim = claimPanel({ origin: "http://127.0.0.1:8788", pid: process.pid + 1, mode: "stdio-panel", dir });
    expect(claim.claimed).toBe(false);
    expect(readPanel(dir)?.origin).toBe("http://127.0.0.1:8787");
  });

  it("takes a record whose process is gone", () => {
    publishPanel({ origin: "http://127.0.0.1:8787", pid: 999_999_999, mode: "http", dir });
    const claim = claimPanel({ origin: "http://127.0.0.1:8788", pid: process.pid, mode: "stdio-panel", dir });
    expect(claim.claimed).toBe(true);
  });

  it("re-claims its own record without complaint", () => {
    publishPanel({ origin: "http://127.0.0.1:8788", pid: process.pid, mode: "stdio-panel", dir });
    expect(claimPanel({ origin: "http://127.0.0.1:8788", pid: process.pid, mode: "stdio-panel", dir }).claimed).toBe(true);
  });
});

describe("releasing the record", () => {
  it("clears our own", () => {
    publishPanel({ origin: "http://127.0.0.1:8788", pid: process.pid, mode: "stdio-panel", dir });
    releasePanel(process.pid, dir);
    expect(readPanel(dir)).toBeNull();
  });

  it("leaves a record another live process took over", () => {
    // Exiting must not delete the record of the panel that replaced us --
    // that would leave a live panel undiscoverable.
    publishPanel({ origin: "http://127.0.0.1:8787", pid: process.pid, mode: "http", dir });
    releasePanel(process.pid + 1, dir);
    expect(readPanel(dir)?.origin).toBe("http://127.0.0.1:8787");
  });
});
