import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PANEL_BODY_LIMIT, readJsonBody } from "@basketed/core";
import { handleApi } from "./api.js";
import { renderApprovals, renderConnect, renderConnections, renderHome, renderLocked, renderSettings, type StoreRow } from "./pages.js";
import { stateOf as chromeLoginStateOf, chromeMode } from "./browser-connect.js";
import type { ControlDeps } from "./types.js";

export * from "./clients.js";
export type { ControlDeps } from "./types.js";
export { closeAll as closeAllChromeLogins } from "./browser-connect.js";
export { readExtensionSeen, noteExtensionSeen, type ExtensionSeen } from "./extension-file.js";

/**
 * The control panel (§7), served by the same process and the same port as the
 * MCP endpoint. One `basketed serve --http`, one thing to run.
 *
 * It is a SEPARATE channel from MCP by construction: the agent speaks JSON-RPC
 * on /mcp and has no route to /api/*, so an approval that arrives here provably
 * did not come from the model.
 *
 * "Provably" rests on the token below, NOT on the route split. Route separation
 * only holds while the agent's sole capability is an MCP tool call, and the
 * clients we install into (Claude Code, Cursor, Codex) all have a shell. A
 * local process can reach any localhost port and can forge any header, so the
 * gate has to be a secret it cannot read: the panel token is minted per process
 * and printed on the server's own console, exactly like the approval code.
 */

/** Header the panel sends. Also accepted as `?t=` on a page load, and as a cookie. */
export const PANEL_TOKEN_HEADER = "x-basketed-token";
export const PANEL_TOKEN_COOKIE = "basketed_panel";

export interface PanelOptions {
  root: string;
  /** Absolute path to packages/cli/bin.js, for the install snippets. */
  binPath: string;
  /**
   * Where this panel is served, e.g. http://127.0.0.1:8787.
   *
   * Authoritative for the Origin check, and separate from `endpoint` because a
   * panel attached to a stdio server has an origin but no MCP endpoint at all.
   */
  origin: string;
  /** The Streamable HTTP MCP endpoint, or null when this process serves stdio. */
  endpoint: string | null;
  version: string;
  /**
   * Per-process secret gating every /api route.
   *
   * Announced ONLY on the server's stderr banner. It must never appear in a
   * response that itself did not carry it, or an agent could simply read it
   * back out of an unauthenticated GET.
   */
  token: string;
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

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    // The panel holds the approval surface. Nothing about it belongs in a
    // frame, and nothing on it should reach out to the network.
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    // The panel is opened with `?t=<token>`. Without this, following the one
    // outbound link on the page would hand that token to the merchant.
    "referrer-policy": "no-referrer",
    // `font-src 'self'` is the ONE thing open here beyond the origin itself,
    // and it is open to this process only: the three families are committed
    // under packages/control/fonts and served from /fonts below. A Google
    // Fonts @import would have needed `style-src https://fonts.googleapis.com`
    // AND `font-src https://fonts.gstatic.com`, and would have told a third
    // party, on every page load, that this machine is running Basketed.
    // There is deliberately no `img-src`: store logos would mean fetching a
    // retailer favicon, which is the same leak in a smaller hat, so the store
    // cards use monograms and this page still fetches nothing off-machine.
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'",
    ...extra,
  });
  res.end(body);
}

/**
 * The three self-hosted faces, served unauthenticated on purpose.
 *
 * They have to be: `renderLocked()` carries no token by design, and a locked
 * page rendered in Times New Roman would be the panel's first impression on
 * anyone who opened it wrong. These are public OFL font binaries — an agent
 * that GETs one learns that this build ships Source Serif 4, and nothing else.
 * The allowlist is exact-match, so the path can never walk out of the folder.
 */
const FONT_DIR = resolve(import.meta.dirname, "../fonts");
const FONTS = new Set([
  "source-serif-4-latin.woff2",
  "instrument-sans-latin.woff2",
  "jetbrains-mono-latin.woff2",
]);

/** Constant-time compare, so a wrong token leaks nothing about the right one. */
function tokenMatches(supplied: string | null, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * Three ways in, one secret: the header the panel script sends, the `?t=` on
 * the URL printed on the console, and the cookie set on a successful page load
 * so a plain refresh still works.
 */
function suppliedToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers[PANEL_TOKEN_HEADER];
  if (typeof header === "string" && header) return header;
  const query = url.searchParams.get("t");
  if (query) return query;
  return cookieValue(req.headers.cookie, PANEL_TOKEN_COOKIE);
}

/**
 * Exact origin equality, never a prefix.
 *
 * `startsWith` would let `http://127.0.0.1:87980` pass for a panel on 8798,
 * and localhost is precisely where a developer runs a dozen other servers.
 * An absent Origin is a refusal on a mutating route: every browser sends one,
 * so absent means the caller is not a browser, and a non-browser caller has to
 * come through the token instead.
 */
function originMatches(origin: string | undefined, panelOrigin: string): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === panelOrigin;
  } catch {
    return false;
  }
}

export function createPanelHandler(
  deps: ControlDeps,
  opts: PanelOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  let benchmark: Benchmark | undefined;
  const panelOrigin = new URL(opts.origin).origin;
  const setCookie = `${PANEL_TOKEN_COOKIE}=${encodeURIComponent(opts.token)}; Path=/; SameSite=Strict; HttpOnly`;
  const log = (msg: string): void => deps.purchase.ctx.log(`panel: ${msg}`);

  return async (req, res) => {
    const url = new URL(req.url ?? "/", panelOrigin);
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    // Never the token itself, on either side of the compare -- this line is
    // meant to answer "why was I refused" from the server's own console
    // without ever putting a secret in that answer.
    const authed = tokenMatches(suppliedToken(req, url), opts.token);
    if (!authed && (path.startsWith("/api/") || path === "/" || path === "/approvals" || path.startsWith("/approvals/") || path === "/connections" || path.startsWith("/connections/") || path === "/settings")) {
      log(`401 ${method} ${path} (${suppliedToken(req, url) ? "token did not match" : "no token supplied"})`);
    }

    // Before the auth gate: the locked page needs its type too, and a font
    // binary is not a secret. Immutable because the filename is versioned by
    // hand — a new subset gets a new name rather than a new body.
    if (method === "GET" && path.startsWith("/fonts/")) {
      const name = path.slice("/fonts/".length);
      if (!FONTS.has(name)) {
        send(res, 404, "text/plain; charset=utf-8", "No such font.");
        return true;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(resolve(FONT_DIR, name));
      } catch {
        // A missing file is a build problem, not a runtime failure: style.ts's
        // fallback stacks render the same design in Georgia and Consolas.
        log(`404 GET ${path} (not on disk — the panel will fall back to system fonts)`);
        send(res, 404, "text/plain; charset=utf-8", "Font not installed.");
        return true;
      }
      res.writeHead(200, {
        "content-type": "font/woff2",
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      res.end(bytes);
      return true;
    }

    if (path.startsWith("/api/")) {
      /*
       * Order matters. Origin is checked first because it is the browser-facing
       * gate and a cross-origin caller should be told that, whatever token it
       * guessed. The token is checked second because it is the real one: it is
       * the only part of this a local process cannot satisfy.
       */
      if (method !== "GET" && !originMatches(req.headers.origin, panelOrigin)) {
        log(`403 ${method} ${path} (Origin was ${req.headers.origin ? JSON.stringify(req.headers.origin) : "absent"})`);
        send(res, 403, "application/json", JSON.stringify({ error: "Cross-origin request refused." }));
        return true;
      }

      if (!authed) {
        send(
          res,
          401,
          "application/json",
          JSON.stringify({
            error:
              "Unauthenticated. The panel token is printed on the Basketed server's own console — " +
              "open the panel from the URL shown there. No agent can read that surface.",
          }),
        );
        return true;
      }

      /*
       * Read once, bounded, and answer the client instead of the route.
       *
       * This used to buffer the whole body unmeasured and turn a parse failure
       * into `{}` -- so a typo in a request arrived at the handler as "you
       * sent no fields", which reads as a bug in the route rather than in the
       * request. 413 and 400 say which one it is.
       */
      const read = await readJsonBody(req, PANEL_BODY_LIMIT);
      if (!read.ok) {
        send(res, read.status, "application/json", JSON.stringify({ error: read.error }));
        return true;
      }
      const body = async (): Promise<Record<string, unknown>> => read.value;
      let result;
      try {
        result = await handleApi(deps, method, path, body);
      } catch (err) {
        // A route that throws must still answer -- an agent-facing 500 with a
        // logged reason beats a hung socket or a stack trace nobody sees.
        const reason = (err as Error).message;
        log(`500 ${method} ${path}: ${reason}`);
        send(res, 500, "application/json", JSON.stringify({ error: "Internal error. See the server's console." }));
        return true;
      }
      if (!result) {
        send(res, 404, "application/json", JSON.stringify({ error: `No route ${method} ${path}.` }));
        return true;
      }
      if (result.status >= 500) log(`${result.status} ${method} ${path}`);
      send(res, result.status, "application/json", JSON.stringify(result.body));
      return true;
    }

    const isPanelPage =
      method === "GET" &&
      (path === "/" ||
        path === "/index.html" ||
        path === "/approvals" ||
        path.startsWith("/approvals/") ||
        path === "/connections" ||
        path.startsWith("/connections/") ||
        path === "/settings");

    if (isPanelPage) {
      // The locked page carries no token, so an agent that GETs the panel
      // learns nothing it could replay against /api.
      if (!authed) {
        send(res, 401, "text/html; charset=utf-8", renderLocked());
        return true;
      }

      if (path === "/settings") {
        send(res, 200, "text/html; charset=utf-8", renderSettings(opts.token), { "set-cookie": setCookie });
        return true;
      }

      if (path === "/approvals" || path.startsWith("/approvals/")) {
        // An approve_url points at a specific approval; the page loads the list
        // and the card is already there, so the id needs no special handling.
        send(res, 200, "text/html; charset=utf-8", renderApprovals(opts.token), { "set-cookie": setCookie });
        return true;
      }

      if (path === "/connections") {
        const stores: StoreRow[] = deps.registry.list().map((s) => ({
          id: s.id,
          name: s.name,
          mode: s.mode,
          country: s.country,
          currency: s.currency,
        }));
        send(res, 200, "text/html; charset=utf-8", renderConnections({ stores, token: opts.token }), {
          "set-cookie": setCookie,
        });
        return true;
      }

      if (path.startsWith("/connections/")) {
        const storeId = decodeURIComponent(path.slice("/connections/".length));
        const store = deps.registry.list().find((s) => s.id === storeId);
        if (!store || store.mode === "simulated") {
          send(
            res,
            404,
            "text/html; charset=utf-8",
            `<!doctype html><meta charset="utf-8"><p>No such store: ${storeId.replace(/[<>&]/g, "")}. <a href="/connections">Back to Connect stores.</a></p>`,
          );
          return true;
        }
        const held = deps.vault.get(storeId);
        send(
          res,
          200,
          "text/html; charset=utf-8",
          renderConnect({
            store: { id: store.id, name: store.name, mode: store.mode, country: store.country, currency: store.currency },
            token: opts.token,
            connected: held
              ? { method: held.kind, username: held.username, broken: held.broken, expired: held.expired }
              : null,
            // "logged_in" is still a window waiting to be captured, so both
            // non-idle states render the waiting card.
            chromeWaiting: chromeLoginStateOf(storeId) !== "idle",
            chrome: await chromeMode(),
            // Absolute, from this process's own root, so the page prints a
            // path that can be pasted straight into Load unpacked.
            extensionDir: resolve(opts.root, "packages/extension"),
          }),
          { "set-cookie": setCookie },
        );
        return true;
      }

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
          token: opts.token,
        }),
        { "set-cookie": setCookie },
      );
      return true;
    }

    return false;
  };
}
