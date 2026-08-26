import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { handleApi } from "./api.js";
import { renderApprovals, renderHome } from "./pages.js";
import type { ControlDeps } from "./types.js";

export * from "./clients.js";
export type { ControlDeps } from "./types.js";

/**
 * The control panel (§7), served by the same process and the same port as the
 * MCP endpoint. One `basketed serve --http`, one thing to run.
 *
 * It is a SEPARATE channel from MCP by construction: the agent speaks JSON-RPC
 * on /mcp and has no route to /api/*, so an approval that arrives here provably
 * did not come from the model.
 */

export interface PanelOptions {
  root: string;
  /** Absolute path to packages/cli/bin.js, for the install snippets. */
  binPath: string;
  endpoint: string;
  version: string;
}

interface Benchmark {
  vsNaive: string;
  vsBrowse: string;
  toolDefs: number;
}

/**
 * Read the published figures out of docs/BENCHMARK.md.
 *
 * Deliberately parsed from the artefact rather than hardcoded: if the panel
 * carried its own copy of the numbers, the two would drift the first time the
 * tool surface changed, and the panel would be quoting a benchmark nobody ran.
 */
async function readBenchmark(root: string): Promise<Benchmark> {
  const fallback: Benchmark = { vsNaive: "—", vsBrowse: "—", toolDefs: 0 };
  try {
    const md = await readFile(resolve(root, "docs/BENCHMARK.md"), "utf8");
    const naive = /vs naive MCP:\**\s*([\d.]+)%/i.exec(md);
    const browse = /vs raw browse:\**\s*([\d.]+)%/i.exec(md);
    // The Basketed row of the table: | C — … | tool defs | search | drill | total |
    const row = /\|\s*C\s*—[^|]*\|\s*([\d,]+)\s*\|/i.exec(md);
    return {
      vsNaive: naive ? `${naive[1]}%` : fallback.vsNaive,
      vsBrowse: browse ? `${browse[1]}%` : fallback.vsBrowse,
      toolDefs: row ? Number(row[1]!.replace(/,/g, "")) : 0,
    };
  } catch {
    return fallback;
  }
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    // The panel holds the approval surface. Nothing about it belongs in a
    // frame, and nothing on it should reach out to the network.
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
  });
  res.end(body);
}

export function createPanelHandler(
  deps: ControlDeps,
  opts: PanelOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  let benchmark: Benchmark | undefined;

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    /*
     * A local panel is still cross-origin reachable from any page the user has
     * open, so a browser could POST an approval on a malicious page's behalf.
     * Same-origin is required on every mutating route -- the approval surface
     * is exactly the thing a CSRF would target.
     */
    if (method !== "GET" && path.startsWith("/api/")) {
      const origin = req.headers.origin;
      if (origin && !origin.startsWith(opts.endpoint.replace(/\/mcp$/, ""))) {
        send(res, 403, "application/json", JSON.stringify({ error: "Cross-origin request refused." }));
        return true;
      }
    }

    if (path.startsWith("/api/")) {
      const body = async (): Promise<Record<string, unknown>> => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        if (!chunks.length) return {};
        try {
          return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {
          return {};
        }
      };
      const result = await handleApi(deps, method, path, body);
      if (!result) {
        send(res, 404, "application/json", JSON.stringify({ error: `No route ${method} ${path}.` }));
        return true;
      }
      send(res, result.status, "application/json", JSON.stringify(result.body));
      return true;
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      benchmark ??= await readBenchmark(opts.root);
      send(
        res,
        200,
        "text/html; charset=utf-8",
        renderHome({
          binPath: opts.binPath,
          endpoint: opts.endpoint,
          platform: process.platform,
          summary: deps.summary,
          fastMode: deps.policy.fastMode,
          storeCount: deps.registry.list().length,
          benchmark,
        }),
      );
      return true;
    }

    if (method === "GET" && (path === "/approvals" || path === "/approvals/")) {
      send(res, 200, "text/html; charset=utf-8", renderApprovals());
      return true;
    }

    // An approve_url points at a specific approval; the page loads the list and
    // the card is already there, so the id needs no special handling.
    if (method === "GET" && path.startsWith("/approvals/")) {
      send(res, 200, "text/html; charset=utf-8", renderApprovals());
      return true;
    }

    return false;
  };
}
