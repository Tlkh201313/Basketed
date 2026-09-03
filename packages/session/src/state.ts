import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

/**
 * `state.json` inside each profile directory: what the last check concluded
 * and when. Metadata only -- a session's cookies live in Chromium's own
 * store next door and its sealed copy in the vault; this file never holds
 * either.
 */

export type SessionState = "live" | "expired" | "checking" | "needs_human" | "unknown";

export interface SessionHealth {
  session_state: SessionState;
  last_verified_at: number | null;
  /** A signal name (see probe.ts), never page content. */
  reason: string | null;
  /** Whether a profile directory exists for the store at all. */
  profile: boolean;
}

const FILE = "state.json";

export function readState(dir: string): SessionHealth {
  const profile = existsSync(dir);
  try {
    const raw = JSON.parse(readFileSync(join(dir, FILE), "utf8")) as Partial<SessionHealth>;
    const states: SessionState[] = ["live", "expired", "checking", "needs_human", "unknown"];
    const state = states.includes(raw.session_state as SessionState) ? (raw.session_state as SessionState) : "unknown";
    return {
      session_state: state === "checking" ? "unknown" : state,
      last_verified_at: typeof raw.last_verified_at === "number" ? raw.last_verified_at : null,
      reason: typeof raw.reason === "string" ? raw.reason : null,
      profile,
    };
  } catch {
    return { session_state: "unknown", last_verified_at: null, reason: null, profile };
  }
}

export function writeState(dir: string, next: Omit<SessionHealth, "profile">): SessionHealth {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, FILE);
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: advisory, like the vault file */
  }
  return { ...next, profile: true };
}
