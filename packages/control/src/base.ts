import { createHash } from "node:crypto";

/**
 * Where the panel's PAGES hang, as a secret path derived from the panel token.
 *
 * This exists for one reason: cookies are not port-isolated. RFC 6265 §8.5
 * scopes a cookie to a host, and for `127.0.0.1` every port is the same host,
 * so a `Path=/` cookie set by the panel on :8787 is sent by the browser to any
 * other localhost server the user happens to load — including one an agent
 * started. `SameSite=Strict` does not help, because a different port is not a
 * different site. That leak matters more than it looks: the panel approval
 * channel's only evidence is the retyped order total, and the total is served
 * by GET /api/approvals, so whoever holds this token can read a pending
 * purchase's total and echo it back to approve it.
 *
 * `Path` is the one cookie attribute the browser DOES enforce per-request, so
 * scoping the cookie to an unguessable path fixes it: a server on another port
 * would have to be asked for this exact path to be handed the cookie, and it
 * cannot guess 96 bits.
 *
 * Derived from the token rather than minted separately so it inherits the
 * token's lifetime exactly — per process, dies with the server, cannot be
 * replayed against the next one (see packages/cli/src/index.ts). It is not a
 * second secret to manage, and it is no weaker than the token it comes from:
 * anyone who can guess this can already guess the thing that mints it.
 *
 * Only pages move. `/api/*` stays where it is, because the panel's own script
 * always sends the token as a header and never relies on the cookie.
 */
export function panelBase(token: string): string {
  return `/b/${createHash("sha256").update(token).digest("base64url").slice(0, 16)}`;
}
