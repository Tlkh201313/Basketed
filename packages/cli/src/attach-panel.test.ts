import { describe, expect, it } from "vitest";
import { attachPanel } from "./index.js";
import type { LivePanel } from "./panel-file.js";
import type { Runtime } from "@basketed/mcp";

/**
 * One tab per machine, not one per server.
 *
 * The bug this pins: Basketed installs into Claude Code, Cursor and Codex, and
 * every one of them starts its own stdio server. Each one bound its own panel
 * port and opened its own browser window, so opening three editors opened
 * three Chrome windows on three ports -- and none of them was more correct
 * than the others, because all three processes read the same database and run
 * as the same principal. The approval queue in ONE panel is already the queue
 * for all of them.
 *
 * `claimPanel` already refused to overwrite a live record; the failure was
 * that nobody read the refusal. These tests read it.
 */

const OWN_ORIGIN = "http://127.0.0.1:8790";
const TOKEN = "own-token";

const panel = {
  origin: OWN_ORIGIN,
  token: TOKEN,
  url: (path: string) => `${OWN_ORIGIN}${path}?token=${TOKEN}`,
};

const incumbentRecord: LivePanel = {
  origin: "http://127.0.0.1:8788",
  pid: 111,
  startedAt: 0,
  mode: "stdio-panel",
};

interface Harness {
  purchase: { panelBase?: string; summon?: (id: string) => void };
  opened: string[];
  lines: string[];
}

function attach(opts: { live: () => LivePanel | null; pid: number; mayOpen?: boolean }): Harness {
  const opened: string[] = [];
  const lines: string[] = [];
  const purchase: Harness["purchase"] = {};
  attachPanel({ purchase } as unknown as Runtime, panel, {
    mayOpen: opts.mayOpen ?? true,
    openAtStartup: true,
    live: opts.live,
    pid: opts.pid,
    open: (url) => void opened.push(url),
    write: (line) => void lines.push(line),
  });
  return { purchase, opened, lines };
}

describe("attachPanel shares one panel across servers (S22)", () => {
  it("opens exactly one tab when this process is the only panel", () => {
    const h = attach({ live: () => null, pid: 222 });
    expect(h.opened).toEqual([`${OWN_ORIGIN}/?token=${TOKEN}`]);
  });

  it("opens nothing when another live panel already holds the record", () => {
    const h = attach({ live: () => incumbentRecord, pid: 222 });
    expect(h.opened).toEqual([]);
    expect(h.lines.join("")).toContain("already open at http://127.0.0.1:8788");
    expect(h.purchase.panelBase).toBe("http://127.0.0.1:8788");
  });

  it("summons the human to the incumbent's panel, and opens no second window", () => {
    const h = attach({ live: () => incumbentRecord, pid: 222 });
    h.purchase.summon!("apr_1");
    expect(h.opened).toEqual([]);
    expect(h.lines.join("")).toContain("http://127.0.0.1:8788/approvals/apr_1");
  });

  it("puts no token on a shared link -- this process does not have the other panel's", () => {
    const h = attach({ live: () => incumbentRecord, pid: 222 });
    h.purchase.summon!("apr_2");
    const printed = h.lines.join("");
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain("token=");
  });

  it("does not defer to a record this very process wrote", () => {
    // Otherwise the one panel that exists would decline to open itself, and
    // `serve --http --open` would print a link and open nothing.
    const h = attach({ live: () => ({ ...incumbentRecord, pid: 222 }), pid: 222 });
    expect(h.opened).toEqual([`${OWN_ORIGIN}/?token=${TOKEN}`]);
  });

  it("falls back to its own panel when the incumbent's editor closes", () => {
    /*
     * The reason `panelBase` is a getter and `live()` is re-read at summon
     * time. An approval can be raised an hour after startup; freezing the
     * incumbent's origin then would keep handing out a link to a dead port,
     * which is worse than the duplicate tab this whole change removes.
     */
    let held: LivePanel | null = incumbentRecord;
    const h = attach({ live: () => held, pid: 222 });
    expect(h.purchase.panelBase).toBe("http://127.0.0.1:8788");

    held = null;
    expect(h.purchase.panelBase).toBe(OWN_ORIGIN);
    h.purchase.summon!("apr_3");
    expect(h.opened).toEqual([`${OWN_ORIGIN}/approvals/apr_3?token=${TOKEN}`]);
  });

  it("honours mayOpen: a server told not to open a browser never opens one", () => {
    const h = attach({ live: () => null, pid: 222, mayOpen: false });
    h.purchase.summon!("apr_4");
    expect(h.opened).toEqual([]);
    expect(h.lines.join("")).toContain(`${OWN_ORIGIN}/approvals/apr_4`);
  });
});
