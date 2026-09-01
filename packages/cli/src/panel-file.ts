import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
}

export function panelDir(): string {
  return resolve(homedir(), ".basketed");
}

function fileIn(dir: string): string {
  return join(dir, "panel.json");
}

export function publishPanel(input: { origin: string; pid: number; dir?: string; now?: number }): void {
  const dir = input.dir ?? panelDir();
  try {
    mkdirSync(dir, { recursive: true });
    const live: LivePanel = { origin: input.origin, pid: input.pid, startedAt: input.now ?? Date.now() };
    writeFileSync(fileIn(dir), `${JSON.stringify(live, null, 2)}\n`, "utf8");
  } catch {
    // Not being able to write a convenience file is never a reason to fail to
    // serve. The banner on the console still says where the panel is.
  }
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
    return { origin: parsed.origin, pid: parsed.pid, startedAt: Number(parsed.startedAt) || 0 };
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
