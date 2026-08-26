import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer, createMcpHandler, type McpHttpHandler, type McpServerFactory } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Runtime } from "./runtime.js";
import { registerReadOnlyTools } from "./tools.js";

export const SERVER_INFO = {
  name: "basketed",
  title: "Basketed",
  version: "0.4.0",
} as const;

/**
 * A fresh `McpServer` per request.
 *
 * MCP 2026-07-28 removed sessions: a server holds no per-connection state, so
 * the SDK builds an instance per exchange. Everything that IS expensive --
 * the store registry, the adapter caches, the token ledger -- lives on the
 * shared `Runtime` and is closed over here rather than rebuilt.
 */
export function createServerFactory(runtime: Runtime): McpServerFactory {
  return () => {
    const server = new McpServer(SERVER_INFO);
    registerReadOnlyTools(server, runtime);
    return server;
  };
}

/**
 * stdio, dual-era.
 *
 * `legacy: 'serve'` is what makes one binary work in both a client that opens
 * with `initialize` (Claude Desktop, Cursor today) and one that speaks the
 * stateless 2026-07-28 dialect. A modern client cannot talk to a legacy-only
 * server and vice versa, so "installs into any agent" depends on this flag
 * being here.
 */
export function serveBasketedStdio(runtime: Runtime): StdioServerHandle {
  return serveStdio(createServerFactory(runtime), {
    legacy: "serve",
    onerror: (err) => runtime.ctx.log(`stdio error: ${err.message}`),
  });
}

/** Streamable HTTP, dual-era for the same reason. */
export function createBasketedHttpHandler(runtime: Runtime): McpHttpHandler {
  return createMcpHandler(createServerFactory(runtime), {
    legacy: "stateless",
    onerror: (err) => runtime.ctx.log(`http error: ${err.message}`),
  });
}

/* ------------------------------------------------- node:http <-> web fetch */

/**
 * Bridge `node:http` to the handler's web-standard `fetch` face.
 *
 * Written by hand rather than pulled from `@modelcontextprotocol/node`: it is
 * thirty lines against globals Node 22 already has, and the control panel
 * (S6) needs to share this port with static assets, so we own the routing
 * either way.
 */
export function toNodeHandler(
  handler: McpHttpHandler,
  origin = "http://127.0.0.1",
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", origin);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
    }

    let body: Buffer | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = Buffer.concat(chunks);
    }

    const request = new Request(url, {
      method: req.method ?? "GET",
      headers,
      ...(body && body.length ? { body: new Uint8Array(body) } : {}),
    });

    const response = await handler.fetch(request);

    const outHeaders: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
      outHeaders[key] = key === "set-cookie" ? [value] : value;
    });
    res.writeHead(response.status, outHeaders);

    if (!response.body) {
      res.end();
      return;
    }

    // Streamed, not buffered: a modern exchange upgrades to SSE when the
    // handler emits progress before its result, and buffering would hold
    // those notifications until the call finished -- which is the one thing
    // they exist to avoid.
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  };
}
