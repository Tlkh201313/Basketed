/**
 * Read the expiry out of a bearer token, when it is a JWT (S21).
 *
 * Both reference implementations this was learned from
 * (GavinAttard/tesco-grocery-mcp and thehesiod/costco-mcp, both MIT) do the
 * same thing for the same reason: a session that has already expired should be
 * reported as expired, not discovered as a 401 halfway through building a
 * basket. Ours goes one step further and reads it at capture time, so the
 * panel can show the runway before anything is spent on finding out.
 *
 * The signature is deliberately not verified, and cannot be -- that would mean
 * holding each retailer's public key, which we have no way to obtain. Nothing
 * is authorised on the strength of this value: it decides what a card in the
 * panel says and when to ask the browser for a fresh session, and both of
 * those fail safe. A forged `exp` costs a wrong label, or one unnecessary
 * re-capture, on a session the user owns anyway.
 */
export function expiryOf(token: string): number | null {
  const raw = token.replace(/^Bearer\s+/i, "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const body = parts[1];
  if (!body) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { exp?: unknown };
    // `exp` is seconds in the spec, and every millisecond in this codebase is
    // a millisecond -- converting here means no caller has to remember which.
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
