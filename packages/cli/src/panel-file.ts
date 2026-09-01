import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where the running panel is, written down.
 *
 * The panel does not always get the port it asks for. 8787 is a popular
 * number, and on stdio this server is started by whichever client happens to
 * launch first -- so it binds whatever is free and moves on. That is the right
 * behaviour (refusing to serve a panel because a port is busy would be worse),
 * but it leaves everything else guessing: docs say 8787, the panel is on
 * 61817, and the person opening a tab gets a connection refused from a port
 * some other process owns.
 *
 * So the live panel writes down where it is. `basketed doctor` reads it, and
 * so can anything else that wants to reach the panel of a server that is
 * already up -- including another CLI on the same machine.
 *
 * What this file deliberately does NOT contain is the panel token. It sits in
 * a directory readable by every process the user runs; a token in it would be
 * a credential on disk, which is the exact thing a per-process token exists to
 * avoid. The URL is not a secret. Everything behind it still needs the token
 * the server prints on its own console.
 */

export interface LivePanel {
  /** e.g. http://127.0.0.1:61817 -- no token, no path. */
  origin: string;
  /** The process serving it, so a stale file can be told from a live one. */
  pid: number;
  /** Epoch ms, for a human reading the file by hand. */
  startedAt: number;
  /**
   * Which transport is serving it.
   *
   * An HTTP panel is strictly more useful than a stdio one -- it has an /mcp
   * endpoint on the same origin -- so it is allowed to take the record over
   * from a stdio panel. Never the reverse: a stdio server starting up must
   * not redirect everything to a panel with no endpoint on it.
   */
  mode: "http" | "stdio-panel";
}

export function panelDir(): string {
  return resolve(homedir(), ".basketed");
}

function fileIn(dir: string): string {
  return join(dir, "panel.json");
}

export interface PublishInput {
  origin: string;
  pid: number;
  mode?: "http" | "stdio-panel";
  dir?: string;
  now?: number;
}

/**
 * Write the record unconditionally. Used only where this process is known to
 * be the one panel; everything else should call `claimPanel`.
 */
export function publishPanel(input: PublishInput): void {
  const dir = input.dir ?? panelDir();
  try {
    mkdirSync(dir, { recursive: true });
    const live: LivePanel = {
      origin: input.origin,
      pid: input.pid,
      startedAt: input.now ?? Date.now(),
      mode: input.mode ?? "http",
    };
    // Written to a sibling and renamed: a reader must never see half a JSON
    // object, and rename is atomic within a directory on every platform here.
    const tmp = `${fileIn(dir)}.${input.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(live, null, 2)}
`, "utf8");
    renameSync(tmp, fileIn(dir));
  } catch {
    // Not being able to write a convenience file is never a reason to fail to
    // serve. The banner on the console still says where the panel is.
  }
}

export type PanelClaim =
  | { claimed: true; previous: LivePanel | null }
  | { claimed: false; held: LivePanel };

/**
 * Take the handoff record, unless a live panel already holds it.
 *
 * Two servers on one machine is normal -- a stdio one per editor, plus an
 * HTTP one someone started by hand -- and they used to fight over this file,
 * last writer winning. That sent `doctor` and every "open the panel" link to
 * whichever process happened to start most recently, which is not usefully
 * the one the human is looking at.
 *
 * The rule is deliberately asymmetric. An HTTP panel may take the record from
 * a live stdio panel, because it also serves /mcp and a human typed a command
 * to start it. A stdio panel never takes it from anything alive: it came up as
 * a side effect of an editor launching, and nobody asked for it.
 *
 * A record whose process is gone is held by no one, and is taken freely.
 */
export function claimPanel(input: PublishInput): PanelClaim {
  const dir = input.dir ?? panelDir();
  const mode = input.mode ?? "http";
  const held = readPanel(dir);
  if (held && held.pid !== input.pid) {
    const mayTakeOver = mode === "http" && held.mode !== "http";
    if (!mayTakeOver) return { claimed: false, held };
  }
  publishPanel(input);
  return { claimed: true, previous: held };
}

/**
 * Drop the record, but only if it is still ours.
 *
 * A process exiting must not delete the record of the panel that took over
 * from it -- that would leave a live panel undiscoverable.
 */
export function releasePanel(pid: number, dir = panelDir()): void {
  const held = readPanel(dir);
  if (held && held.pid !== pid) return;
  clearPanel(dir);
}

/** Is that pid still one of ours? Signal 0 tests without touching the process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else -- still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The live panel, or null.
 *
 * Null for a missing file, a corrupt one, or one whose process is gone. A
 * stale file from a crashed run must not send anyone to a dead port -- that is
 * the failure this whole file exists to end, not one to reproduce.
 */
export function readPanel(dir = panelDir()): LivePanel | null {
  const path = fileIn(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LivePanel>;
    if (typeof parsed.origin !== "string" || typeof parsed.pid !== "number") return null;
    if (!alive(parsed.pid)) return null;
    return {
      origin: parsed.origin,
      pid: parsed.pid,
      startedAt: Number(parsed.startedAt) || 0,
      // Records written before this field existed were all HTTP panels.
      mode: parsed.mode === "stdio-panel" ? "stdio-panel" : "http",
    };
  } catch {
    return null;
  }
}

export function clearPanel(dir = panelDir()): void {
  try {
    rmSync(fileIn(dir), { force: true });
  } catch {
    // Same reasoning as publishPanel: this is a convenience, not a promise.
  }
}
