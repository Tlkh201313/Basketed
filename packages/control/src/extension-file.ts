import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Whether the browser extension has ever spoken to a panel on this machine.
 *
 * `doctor` runs in its own process, minutes or days after the serve that the
 * extension actually talked to, so it cannot observe the handshake directly.
 * Without a note on disk the one check that matters most -- "is the piece that
 * makes Connect finish by itself actually installed?" -- is the one check
 * doctor could not perform, and a user whose extension is missing got no line
 * about it anywhere: the panel only mentions the extension AFTER a connect has
 * already failed.
 *
 * So the verify handshake leaves a mark. It is a timestamp and a browser's own
 * description of itself, nothing else: no token (that is the whole point of
 * panel.json's rule and it holds here), no cookie, no store, no session. A
 * process that reads this file learns that this user has the extension. That
 * is not a secret; it is the fact doctor exists to report.
 *
 * Absence proves nothing on its own -- the extension may be installed in a
 * browser that has not opened the panel yet -- so doctor reports it as
 * something to do, never as a failure.
 */

export interface ExtensionSeen {
  /** Epoch ms of the last verify handshake. */
  seenAt: number;
  /** The extension's own version string, as it reported it. */
  version: string;
}

/*
 * `BASKETED_STATE_DIR` exists so a test suite -- which serves a real panel and
 * hits the real verify route -- does not leave a note in the developer's home
 * saying an extension has connected when none has. A doctor that reports that
 * to someone with no extension installed is worse than one that says nothing.
 */
export function extensionDir(): string {
  return process.env["BASKETED_STATE_DIR"] ?? resolve(homedir(), ".basketed");
}

function fileIn(dir: string): string {
  return join(dir, "extension.json");
}

export function noteExtensionSeen(input: { version?: string; dir?: string; now?: number } = {}): void {
  const dir = input.dir ?? extensionDir();
  try {
    mkdirSync(dir, { recursive: true });
    const seen: ExtensionSeen = {
      seenAt: input.now ?? Date.now(),
      // Whatever it says, bounded: this string is written by an extension and
      // read back by a CLI that prints it, so it is treated as untrusted text.
      version: String(input.version ?? "").slice(0, 32),
    };
    writeFileSync(fileIn(dir), `${JSON.stringify(seen, null, 2)}\n`, "utf8");
  } catch {
    // A note nobody could write is not a reason to refuse the handshake. The
    // extension still works; only doctor's report is poorer for it.
  }
}

export function readExtensionSeen(dir = extensionDir()): ExtensionSeen | null {
  const path = fileIn(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ExtensionSeen>;
    const seenAt = Number(parsed.seenAt);
    if (!Number.isFinite(seenAt) || seenAt <= 0) return null;
    return { seenAt, version: String(parsed.version ?? "").slice(0, 32) };
  } catch {
    return null;
  }
}
