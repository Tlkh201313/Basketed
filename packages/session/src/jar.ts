import type { StoreLogin } from "./descriptors.js";

/**
 * A session captured from the user's OWN browser (the Basketed Connect
 * extension) arrives as a `Cookie:` header and, if the store puts one on
 * the wire, a bearer. The bearer dies in an hour; the jar is what renews it.
 *
 * There is no plain-HTTP renewal: Tesco's edge (Akamai) answers a Node
 * `fetch` carrying a perfectly good jar with 403, because the TLS and
 * header fingerprint is not a browser's. So the jar is SEEDED once into a
 * headless stealth profile of ours -- the same kind every other connection
 * lives in -- and from then on the profile renews itself and the health pass
 * re-seals it, exactly as if the user had signed in there. The jar row is
 * forgotten the moment it has been seeded.
 */

/** A token the page carries in its own inline state (see `StoreLogin.bearer.pagePattern`). */
export function bearerFromHtml(html: string, pattern: RegExp): string | null {
  const raw = pattern.exec(html)?.[1];
  if (!raw) return null;
  let value = raw;
  try {
    value = JSON.parse(`"${raw}"`) as string; // undo / and friends
  } catch {
    /* not a JSON string literal: take it as written */
  }
  value = value.replace(/^Bearer\s+/i, "").trim();
  return value.length > 0 ? value : null;
}

export interface SeedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expires: number;
}

/**
 * A `Cookie:` header as cookies a browser context can adopt. The header
 * carries names and values only, so every cookie is set on the store's
 * registrable domain (which its subdomains inherit) and given a year: the
 * store rotates and re-scopes them on the first response anyway.
 */
export function cookiesFromHeader(header: string, d: StoreLogin, now: number = Date.now()): SeedCookie[] {
  const expires = Math.floor(now / 1000) + 365 * 24 * 60 * 60;
  const out: SeedCookie[] = [];
  const seen = new Set<string>();
  for (const pair of header.split(/;\s*/)) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1);
    if (!name || !value || seen.has(name)) continue;
    seen.add(name);
    for (const domain of d.domains) {
      out.push({ name, value, domain: `.${domain}`, path: "/", secure: true, expires });
    }
  }
  return out;
}
