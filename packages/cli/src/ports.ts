import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Who owns a local port, and what to say when it is taken.
 *
 * Two servers in this repo want a port: the HTTP transport, which must have
 * the exact one it advertises, and the stdio panel, which only needs somewhere
 * to be. They used to want the SAME one (8787), which produced the worst
 * possible failure: a stdio panel squatting on the port an HTTP client had
 * been told to POST /mcp to, answering every request with a 404 that looks
 * like a broken server rather than the wrong process.
 *
 * They are now separate numbers (see DEFAULT_HTTP_PORT / DEFAULT_PANEL_PORT),
 * and whichever one is busy, we can say who has it -- because both of our
 * servers answer /healthz with their own name, pid and mode.
 */

/** The Streamable HTTP transport. Half of an endpoint people paste into a config. */
export const DEFAULT_HTTP_PORT = 8787;

/**
 * The panel that comes up beside a stdio server.
 *
 * Deliberately NOT 8787. A stdio process serves no /mcp, so squatting on the
 * documented HTTP port makes a client's endpoint answer 404 forever with
 * nothing in either log to explain it. `BASKETED_PANEL_PORT` still wins, and
 * a busy port here is still resolved by moving, since this one is discovered
 * from panel.json rather than typed by a human.
 */
export const DEFAULT_PANEL_PORT = 8788;

/** What a Basketed server says about itself at /healthz. */
export interface PortOwner {
  name: string;
  pid: number;
  /** "http" serves /mcp; "stdio-panel" is a panel with no MCP endpoint. */
  mode: "http" | "stdio-panel";
  stores?: string;
  version?: string;
}

/**
 * Bind the preferred port if it is free, otherwise take any port at all.
 *
 * Only for the panel. The HTTP transport must fail loudly instead -- see
 * busyPortMessage.
 */
export async function listenSomewhere(server: Server, preferred: number): Promise<number | null> {
  for (const port of [preferred, 0]) {
    const bound = await new Promise<number | null>((res) => {
      const onError = () => {
        server.removeListener("listening", onListening);
        res(null);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        res((server.address() as AddressInfo).port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (bound !== null) return bound;
  }
  return null;
}

/**
 * Ask whatever is on a port to identify itself.
 *
 * Returns null for a free port, for something that is not ours, and for
 * anything that does not answer inside the timeout. Never throws: this is
 * only ever used to make an error message more useful, so failing to find out
 * must degrade to saying less, not to a second error.
 */
export async function describePort(
  port: number,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<PortOwner | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 700);
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/healthz`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<PortOwner> & { server?: { name?: string; version?: string } };
    const name = body.name ?? body.server?.name;
    if (name !== "basketed") return null;
    return {
      name: "basketed",
      pid: Number(body.pid) || 0,
      mode: body.mode === "stdio-panel" ? "stdio-panel" : "http",
      ...(body.stores ? { stores: body.stores } : {}),
      ...(body.version ?? body.server?.version ? { version: body.version ?? body.server?.version } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * What to print when the HTTP transport cannot have the port it was asked for.
 *
 * The advice differs by who is squatting, because the fix does:
 *
 *  - our own stdio panel: it moved here because BASKETED_PANEL_PORT said so,
 *    and the answer is to give it a different number, not to move the endpoint
 *    every client config already names.
 *  - another Basketed HTTP server: there is already one running; use it.
 *  - somebody else entirely: pick another port.
 */
export function busyPortMessage(port: number, owner: PortOwner | null): string {
  const head = `[basketed] port ${port} is already in use`;
  if (owner?.mode === "stdio-panel") {
    return (
      `${head} by a Basketed stdio panel (pid ${owner.pid}).\n` +
      `[basketed] That process serves MCP over stdio, so this port has no /mcp on it.\n` +
      `[basketed] Move the panel instead: BASKETED_PANEL_PORT=${DEFAULT_PANEL_PORT} on the stdio server,\n` +
      `[basketed] or stop pid ${owner.pid} and start this one again.\n`
    );
  }
  if (owner?.mode === "http") {
    return (
      `${head} by another Basketed HTTP server (pid ${owner.pid}).\n` +
      `[basketed] One is already serving http://127.0.0.1:${port}/mcp -- point your client at that,\n` +
      `[basketed] or stop pid ${owner.pid} first.\n`
    );
  }
  return (
    `${head} by another process.\n` +
    `[basketed] Pick a free one: basketed serve --http --port 8790 --open\n` +
    `[basketed] (stdio needs no port at all, and brings the panel with it.)\n`
  );
}

/** One line per port, for `basketed doctor`. */
export function describeOwnerLine(port: number, owner: PortOwner | null, expected: string): string {
  if (!owner) return `  ${port}  free — ${expected}`;
  const who = owner.mode === "http" ? "Basketed HTTP server (serves /mcp)" : "Basketed stdio panel (no /mcp)";
  // A server older than this field reports no pid; saying "pid 0" would send
  // somebody looking for a process that does not exist.
  return owner.pid > 0 ? `  ${port}  ${who}, pid ${owner.pid}` : `  ${port}  ${who}`;
}
