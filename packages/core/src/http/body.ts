import type { IncomingMessage } from "node:http";

/**
 * Reading a request body without letting the sender decide how much memory we
 * spend.
 *
 * Both servers used to do `for await (const chunk of req) chunks.push(chunk)`,
 * which is an unbounded buffer with no back-pressure: one POST with a
 * Content-Length nobody checked was enough to walk the process out of memory,
 * and there is no authentication in front of the MCP route because MCP does
 * not have one. That is not a remote attacker on a loopback listener -- it is
 * a confused client, a runaway script, or a proxy replaying a large upload --
 * but the failure is the whole server, not the request.
 *
 * The limits are per-surface because the surfaces are different. An MCP call
 * can legitimately carry a long tool argument; a panel form field cannot.
 */

/** MCP: a tool call may carry a real payload. */
export const MCP_BODY_LIMIT = 1024 * 1024;

/** Panel: a handful of form fields and a token. Nothing here is a document. */
export const PANEL_BODY_LIMIT = 64 * 1024;

export type BodyResult =
  | { ok: true; body: Buffer }
  | { ok: false; status: 413 | 400; error: string };

export type JsonBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 413 | 400; error: string };

/**
 * Collects the body, stopping the moment it goes over `limit`.
 *
 * Checks the declared Content-Length first so an oversized upload is refused
 * before a single byte is buffered, and then counts what actually arrives --
 * a chunked request declares no length at all, and a lying one declares the
 * wrong one. Never throws.
 */
export async function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) return tooLarge(limit);

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > limit) {
        // Stop reading. Leaving the socket draining a body we have already
        // refused is the same unbounded read with extra steps.
        req.destroy();
        return tooLarge(limit);
      }
      chunks.push(buf);
    }
  } catch (err) {
    // An aborted upload is the client's business, not a 500.
    return { ok: false, status: 400, error: `Could not read the request body: ${(err as Error).message}` };
  }
  return { ok: true, body: Buffer.concat(chunks) };
}

/**
 * `readBody` plus a JSON parse. An empty body is `{}` -- several panel routes
 * are legitimately parameterless POSTs -- but a body that is present and not
 * valid JSON is a 400 rather than the silent `{}` it used to become. Swallowing
 * it meant a typo in a request arrived as "you sent no fields", which reads as
 * a bug in the route.
 */
export async function readJsonBody(req: IncomingMessage, limit: number): Promise<JsonBodyResult> {
  const raw = await readBody(req, limit);
  if (!raw.ok) return raw;
  const text = raw.body.toString("utf8").trim();
  if (!text) return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, status: 400, error: `Request body is not valid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function tooLarge(limit: number): BodyResult & { ok: false } {
  return {
    ok: false,
    status: 413,
    error: `Request body is larger than ${Math.round(limit / 1024)} KiB and was refused unread.`,
  };
}

/**
 * How long a client may take to finish what it started.
 *
 * Node's own defaults are generous enough that a socket which sends a header
 * line and then nothing holds a connection indefinitely. These are per-server
 * and deliberately unequal: a tool call can be slow because a retailer is
 * slow, a panel form cannot.
 */
export const MCP_TIMEOUTS = { headersTimeout: 20_000, requestTimeout: 120_000 } as const;
export const PANEL_TIMEOUTS = { headersTimeout: 10_000, requestTimeout: 30_000 } as const;
