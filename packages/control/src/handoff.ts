/**
 * Connecting a store in the browser the user is already using (S20).
 *
 * ## Why this file exists at all
 *
 * S19 opened the sign-in tab by driving a browser over CDP. That works, and
 * it auto-captures, but it can never be the user's OWN Chrome window, and the
 * reason is not laziness: since Chrome 136, `--remote-debugging-port` is
 * ignored unless it is paired with a non-default `--user-data-dir`. Chrome
 * did that deliberately, to stop exactly the thing an auto-capture is -- one
 * process reading another profile's cookies. Their real profile is off the
 * table for CDP, permanently, by design.
 *
 * So the tab does not get opened by the server at all. The panel is ALREADY
 * a page in the user's browser: a plain `target="_blank"` link from it opens
 * a new tab in that same browser, same profile, same logins, no automation,
 * no second Chrome. That is the whole trick, and it is what a person means
 * when they say "just open a tab".
 *
 * What the server keeps is the other half: a note saying "a sign-in for this
 * store is in flight, and here is what a finished one looks like". The
 * Basketed browser extension -- running in that same browser, where reading
 * its own cookies is allowed -- picks the note up and posts the session back.
 * No extension installed means no capture from that tab, which is a real
 * limit and the panel says so rather than spinning forever.
 *
 * ## What this is not
 *
 * Not a credential store: nothing here holds a secret. The pending note is
 * the store id, its domains, and the cookie names that mean "signed in" --
 * all of it already public in `connections.ts`. The captured session goes
 * straight to the vault through the same token-gated route as everything
 * else and never lands here.
 */

export interface PendingConnect {
  storeId: string;
  storeName: string;
  /** Where the tab was sent. Kept so the panel can re-open it. */
  url: string;
  domains: string[];
  authCookies: string[];
  /** URL substring whose `Authorization` header is the credential (Tesco). */
  bearerMatch: string | null;
  startedAt: number;
  /** Set when a capture arrived, so the panel can report how it finished. */
  finishedBy: "extension" | null;
}

const pending = new Map<string, PendingConnect>();

/**
 * How long a note lives. Long enough to find a password manager and a 2FA
 * code, short enough that a tab abandoned an hour ago is not still asking an
 * extension to read cookies for it.
 */
export const TTL_MS = 15 * 60 * 1000;

function fresh(p: PendingConnect): boolean {
  return Date.now() - p.startedAt < TTL_MS;
}

/** Drop anything past its TTL. Called on every read, so nothing needs a timer. */
function sweep(): void {
  for (const [id, p] of pending) if (!fresh(p)) pending.delete(id);
}

export function openConnect(p: Omit<PendingConnect, "startedAt" | "finishedBy">): PendingConnect {
  sweep();
  const note: PendingConnect = { ...p, startedAt: Date.now(), finishedBy: null };
  pending.set(p.storeId, note);
  return note;
}

export function pendingFor(storeId: string): PendingConnect | null {
  sweep();
  return pending.get(storeId) ?? null;
}

/**
 * What the extension asks for: everything currently waiting on a sign-in.
 *
 * Deliberately says nothing about whether a store is already connected --
 * that would turn a list of open tabs into a report on the vault's contents,
 * and the extension has no business knowing either way.
 */
export function listPending(): PendingConnect[] {
  sweep();
  return [...pending.values()];
}

export function closeConnect(storeId: string): boolean {
  return pending.delete(storeId);
}

/** Mark one finished, so the panel can say how rather than just that it did. */
export function finish(storeId: string, by: "extension"): void {
  const p = pending.get(storeId);
  if (p) p.finishedBy = by;
}

/** Everything the panel polls for, in the shape it renders. */
export function statusFor(storeId: string): {
  waiting: boolean;
  waited_ms: number;
  finished_by: "extension" | null;
} {
  const p = pendingFor(storeId);
  return {
    waiting: p !== null && p.finishedBy === null,
    waited_ms: p ? Date.now() - p.startedAt : 0,
    finished_by: p?.finishedBy ?? null,
  };
}

/** Test seam: the module is process-global state, so suites must be able to reset it. */
export function resetHandoff(): void {
  pending.clear();
}
