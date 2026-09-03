import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StoreRegistry, SimulatedAdapter, ShopifyUcpAdapter, TescoAdapter, AmazonAdapter, type AdapterCtx } from "@basketed/adapters";
import {
  addToBasket,
  loadGuardrails,
  loadShoppingMode,
  openDb,
  prepareCart,
  saveGuardrails,
  type PurchaseDeps,
} from "@basketed/commerce";
import type { FxTable } from "@basketed/core";
import { openVault, degradedVault, loginKey, type Vault } from "@basketed/vault";
import type { SessionManager, SessionHealth } from "@basketed/session";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelHandler } from "./index.js";
import { panelBase } from "./base.js";
import { authPolicyFor } from "./connections.js";
import { resetHandoff } from "./handoff.js";
import type { ControlDeps } from "./types.js";

/**
 * The sign-in engine (S23) is real automation of a real browser -- not
 * something a unit test should launch. The route-level contract (auth
 * gating, 400/404/409/503 paths, and that nothing captured ever echoes back)
 * is what is under test here; `@basketed/session` has its own tests.
 */
const UNKNOWN: SessionHealth = { session_state: "unknown", last_verified_at: null, reason: null, profile: false };
function fakeSessions(vault: () => Vault): SessionManager {
  return {
    loginFor: (id) => (id.startsWith("sim:") || id === "tsc:tesco" || id === "amz:amazon" ? ({} as never) : null),
    hasProfile: vi.fn(() => false),
    hasJar: vi.fn(() => false),
    hasCredentials: vi.fn((id: string) => vault().get(loginKey(id)) !== null),
    openLogin: vi.fn(async () => ({ ok: true as const, state: "waiting" as const })),
    pollStatus: vi.fn(() => ({ state: "idle" as const, human: null, waited_ms: 0, error: null })),
    finishLogin: vi.fn(async () => ({ ok: false as const, error: "No sign-in window is open for this store." })),
    cancelLogin: vi.fn(async () => false),
    health: vi.fn(() => UNKNOWN),
    checkSession: vi.fn(async () => UNKNOWN),
    reloginWithCredentials: vi.fn(async () => UNKNOWN),
    refresh: vi.fn(async () => ({ ok: false as const, state: "expired" as const })),
    forgetProfile: vi.fn(async () => false),
    closeAll: vi.fn(async () => {}),
  };
}
let sessions: SessionManager;

/**
 * The test that would have caught it.
 *
 * The panel was the approval channel, and its only gate was an Origin header —
 * a header a caller chooses whether to send. Basketed installs into Claude
 * Code, Cursor and Codex, and every one of them has a shell, so "the agent
 * cannot reach /api" was never true: one curl with no Origin approved a cart
 * the model had prepared, end to end, with no human anywhere in it.
 *
 * So the claim under test is not "the panel checks an Origin". It is that an
 * unauthenticated local caller cannot approve, cannot reject, cannot move an
 * order and cannot widen a cap — and leaves no state behind when it tries.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const PRINCIPAL = "local:test";
const ctx: AdapterCtx = { http: fetch, log: () => {}, snapshots: true };
const TOKEN = randomBytes(32).toString("base64url");

let server: Server;
let base: string;
let deps: ControlDeps;
let purchase: PurchaseDeps;
let handler!: ReturnType<typeof createPanelHandler>;
let approvalId: string;
let vault: Vault;

beforeAll(async () => {
  server = createServer((req, res) => {
    handler(req, res)
      .then((served) => {
        if (served) return;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Not found." }));
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(async () => {
  resetHandoff();
  const registry = new StoreRegistry();
  for (const a of await SimulatedAdapter.loadAll(ROOT)) registry.register(a);
  // Every store with an account now offers the browser sign-in (S19, S23),
  // so the "nothing to connect" routes need a store that genuinely has no
  // account: a Shopify UCP merchant, whose endpoint is anonymous.
  registry.register(new ShopifyUcpAdapter({ endpoint: "https://example.test/ucp", domain: "example.test", name: "Example UCP" }));
  const tesco = registry.get("sim:tesco")!;
  const productIds = (await tesco.search({ query: "coffee", maxResults: 2 }, ctx)).map((p) => p.id);

  const fx = JSON.parse(await readFile(resolve(ROOT, "fixtures/fx.json"), "utf8")) as FxTable;
  purchase = { db: openDb(":memory:"), registry, ctx, fx, announce: () => {} };
  saveGuardrails(purchase.db, { homeCurrency: "GBP", perOrderCap: 1000, dailyCap: 5000 });
  // The approval routes under test belong to purchase mode, which this build
  // locks (S24). The row is written directly; the save path refuses it.
  purchase.db.prepare("INSERT INTO settings (k, v) VALUES ('shopping_mode', 'purchase')").run();

  deps = {
    purchase,
    registry,
    principal: PRINCIPAL,
    policy: { fastMode: false },
    ledger: { report: () => ({}) },
    summary: "1 store (simulated)",
    version: "test",
    redactionAlarms: () => 0,
    // A real vault on a throwaway key, so the connection tests exercise the
    // actual crypto rather than a stub that cannot fail the way it can.
    vault: openVault(purchase.db, { keyPath: join(mkdtempSync(join(tmpdir(), "bk-key-")), "master.key") }),
    sessions: fakeSessions(() => vault),
  };
  vault = deps.vault;
  sessions = deps.sessions;

  handler = createPanelHandler(deps, {
    root: ROOT,
    binPath: resolve(ROOT, "packages/cli/bin.js"),
    origin: base,
    endpoint: `${base}/mcp`,
    version: "test",
    token: TOKEN,
  });

  ({ approvalId } = await prepareCart(purchase, {
    items: [{ id: productIds[0]!, quantity: 1 }],
    accountHandle: "acct_guest_sim_tesco",
    principal: PRINCIPAL,
  }));
});

/** What an agent with a shell can send: no token, and whatever Origin it likes. */
function raw(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, init);
}

/** What the panel itself sends: the token, and its own Origin. */
function panel(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "x-basketed-token": TOKEN,
      ...(method === "GET" ? {} : { origin: base }),
      ...(init.headers ?? {}),
    },
  });
}

/** The one card the panel would render, read the way the panel reads it. */
async function pendingTotal(): Promise<string> {
  const body = (await panel("/api/approvals").then((r) => r.json())) as {
    approvals: Array<{ total: { value: number } }>;
  };
  return body.approvals[0]!.total.value.toFixed(2);
}

function stateOf(id: string): string {
  const row = purchase.db.prepare("SELECT state FROM approvals WHERE id = ?").get(id) as { state: string };
  return row.state;
}

describe("6 — an unauthenticated local caller cannot approve", () => {
  it("refuses the approve route and leaves the approval PENDING", async () => {
    const typed = await pendingTotal();

    // The exact request that worked before: correct total, no Origin, no token.
    const res = await raw(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typed_total: typed }),
    });

    expect(res.status).not.toBe(200);
    expect(stateOf(approvalId)).toBe("PENDING");
  });

  it("refuses it with a forged same-origin header too", async () => {
    // An Origin binds browsers. A local process can type any string it likes,
    // which is exactly why the header cannot be the gate.
    const res = await raw(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ typed_total: "0.01" }),
    });

    expect(res.status).toBe(401);
    expect(stateOf(approvalId)).toBe("PENDING");
  });

  it("refuses reject, order outcome and guardrail writes", async () => {
    const reject = await raw(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, {
      method: "POST",
      headers: { origin: base },
    });
    expect(reject.status).toBe(401);
    expect(stateOf(approvalId)).toBe("PENDING");

    const outcome = await raw("/api/orders/ord_anything/outcome", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ state: "CONFIRMED" }),
    });
    expect(outcome.status).toBe(401);

    const before = loadGuardrails(purchase.db);
    const caps = await raw("/api/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ per_order_cap: 999_999, daily_cap: 999_999 }),
    });
    expect(caps.status).toBe(401);
    expect(loadGuardrails(purchase.db)).toEqual(before);

    const mode = await raw("/api/settings/mode", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ mode: "basket" }),
    });
    expect(mode.status).toBe(401);
    expect(loadShoppingMode(purchase.db)).toBe("purchase");
  });

  it("tells it nothing it could read a total or an id out of", async () => {
    const list = await raw("/api/approvals");
    expect(list.status).toBe(401);
    expect(await list.text()).not.toContain(approvalId);

    // The page is the other way an id could leak, and it must not carry the
    // token either — a locked page that embeds the secret is not locked.
    const page = await raw("/approvals");
    const html = await page.text();
    expect(page.status).toBe(401);
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain(approvalId);
  });
});

describe("the panel's own requests still work", () => {
  it("approves with the token, the Origin and the exact total", async () => {
    const typed = await pendingTotal();

    const res = await panel(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typed_total: typed }),
    });

    expect(res.status).toBe(200);
    expect(stateOf(approvalId)).toBe("APPROVED");
  });

  it("serves the page to a ?t= link and embeds the token there", async () => {
    const page = await raw(`/approvals?t=${TOKEN}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain(TOKEN);
  });

  /*
   * Cookies are not port-isolated (RFC 6265 s8.5): to the browser,
   * 127.0.0.1:9999 is the same host as 127.0.0.1:8787, so a cookie on Path=/
   * is handed to every other local server this browser touches. That is not a
   * metadata leak -- this token approves purchases, because the approval
   * card's only evidence is the total and /api/approvals serves it. Path is
   * the one attribute a browser enforces per request, so the pages live under
   * a prefix derived from the token and the cookie is scoped to that.
   */
  it("the panel cookie cannot be read by another port on this machine", async () => {
    const page = await raw(`/approvals?t=${TOKEN}`);
    const cookie = page.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("basketed_panel=");

    const path = /Path=([^;]+)/.exec(cookie)?.[1] ?? "";
    expect(path, "a cookie on Path=/ reaches every other local port").not.toBe("/");
    // Derived from the token, so it inherits the token's per-process life.
    expect(path).toBe(panelBase(TOKEN));

    // And the pages really are served there, with internal links that stay
    // inside the prefix -- a relative link out of it would drop the cookie on
    // the first click and put the token back in the query string.
    const scoped = await raw(`${path}/approvals?t=${TOKEN}`);
    expect(scoped.status).toBe(200);
    expect(await scoped.text()).toContain(`href="${path}/approvals"`);
  });
});

describe("the browser-facing half of the gate", () => {
  it("refuses a cross-origin POST even when the token is right", async () => {
    const res = await panel(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, {
      method: "POST",
      headers: { origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(stateOf(approvalId)).toBe("PENDING");
  });

  it("refuses an Origin that merely starts with ours", async () => {
    // `startsWith` would have let this through: localhost is exactly where a
    // developer runs a dozen other servers, and :8798 is a prefix of :87980.
    const res = await panel(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, {
      method: "POST",
      headers: { origin: `${base}0` },
    });
    expect(res.status).toBe(403);
    expect(stateOf(approvalId)).toBe("PENDING");
  });

  it("refuses a mutating request with no Origin at all", async () => {
    // Right token, no Origin -- a shell, not a browser. Every browser sends
    // one, so absent is a refusal rather than a pass.
    const res = await fetch(`${base}/api/approvals/${encodeURIComponent(approvalId)}/reject`, {
      method: "POST",
      headers: { "x-basketed-token": TOKEN },
    });
    expect(res.status).toBe(403);
    expect(stateOf(approvalId)).toBe("PENDING");
  });
});

describe("the guardrail route refuses a value that is not a policy", () => {
  it("answers 400 and changes nothing on a negative cap", async () => {
    const before = loadGuardrails(purchase.db);
    const res = await panel("/api/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ per_order_cap: -1 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/negative/);
    expect(loadGuardrails(purchase.db)).toEqual(before);
  });

  it("answers 400 on a cap that is really the absence of one", async () => {
    const res = await panel("/api/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ daily_cap: 1e308 }),
    });
    expect(res.status).toBe(400);
    expect(loadGuardrails(purchase.db).dailyCap).toBe(5000);
  });

  it("answers 400 on something that is not a number at all", async () => {
    // `Number("lots")` is NaN, and a NaN in the settings table reads back as
    // the DEFAULT cap -- the user would be running 250 while the panel showed
    // what they typed.
    const res = await panel("/api/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ per_order_cap: "lots" }),
    });
    expect(res.status).toBe(400);
    expect(loadGuardrails(purchase.db).perOrderCap).toBe(1000);
  });

  it("still takes a cap a person would actually set", async () => {
    const res = await panel("/api/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ per_order_cap: 42.5, home_currency: "usd" }),
    });
    expect(res.status).toBe(200);
    const after = loadGuardrails(purchase.db);
    expect(after.perOrderCap).toBe(42.5);
    expect(after.homeCurrency).toBe("USD");
  });
});

describe("the store allowlist can finally be set", () => {
  it("writes a real store id and reads it back", async () => {
    const res = await panel("/api/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed_stores: ["sim:tesco"] }),
    });
    expect(res.status).toBe(200);
    expect(loadGuardrails(purchase.db).allowedStores).toEqual(["sim:tesco"]);
  });

  it("refuses a store that does not exist, rather than silently blocking everything", async () => {
    // An empty allowlist means "any store". A typo'd one means "no store,
    // ever", with a refusal that names a guardrail instead of the typo.
    const res = await panel("/api/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed_stores: ["sim:tesco", "sim:nosuchshop"] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/sim:nosuchshop/);
    expect(loadGuardrails(purchase.db).allowedStores).toEqual([]);
  });

  it("refuses something that is not a list", async () => {
    const res = await panel("/api/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed_stores: "sim:tesco" }),
    });
    expect(res.status).toBe(400);
  });

  it("takes an address allowlist too, so the live guardrail can be armed", async () => {
    const res = await panel("/api/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed_addresses: ["addr_home"] }),
    });
    expect(res.status).toBe(200);
    expect(loadGuardrails(purchase.db).allowedAddresses).toEqual(["addr_home"]);
  });
});

/* --------------------------------- the panel that rides along with stdio */

/**
 * When the panel is attached to a stdio server (S13) there is no Streamable
 * HTTP endpoint in the process at all. It used to be handed one anyway --
 * `PanelOptions.endpoint` was also what the Origin check was derived from --
 * and the Install page would print a URL that answers nothing.
 */
describe("attached to a stdio server, with no MCP endpoint of its own", () => {
  function stdioHandler() {
    return createPanelHandler(deps, {
      root: ROOT,
      binPath: resolve(ROOT, "packages/cli/bin.js"),
      origin: base,
      endpoint: null,
      version: "test",
      token: TOKEN,
    });
  }

  it("says so instead of printing an endpoint that would not answer", async () => {
    handler = stdioHandler();
    const html = await (await panel("/")).text();
    expect(html).toContain("stdio");
    expect(html).not.toContain("/mcp");
  });

  it("still knows its own origin, so the Origin check is unchanged", async () => {
    handler = stdioHandler();
    const good = await panel("/api/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ per_order_cap: 42 }),
    });
    expect(good.status).toBe(200);

    const evil = await fetch(`${base}/api/guardrails`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-basketed-token": TOKEN, origin: "http://evil.example" },
      body: JSON.stringify({ per_order_cap: 43 }),
    });
    expect(evil.status).toBe(403);
    expect(loadGuardrails(purchase.db).perOrderCap).toBe(42);
  });
});

/* ------------------------------------------------------------ connections */

/**
 * Approval channel A had ONE gate: the panel token. The vault adds a second
 * thing behind that same gate, and the point of this suite is that "behind
 * the same gate" is actually true -- every /api/connections route refuses the
 * same way /api/approvals always has, and on top of that, nothing here ever
 * echoes a secret back, not even to a caller that just supplied one.
 */
describe("connections (S14)", () => {
  it("lists every registered store with a real auth policy, unauthenticated refused", async () => {
    const noToken = await raw("/api/connections");
    expect(noToken.status).toBe(401);

    const res = await panel("/api/connections");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: Array<Record<string, unknown>> };
    const tesco = body.connections.find((c) => c["store_id"] === "sim:tesco");
    expect(tesco).toBeTruthy();
    // S19: one method, and it is the one the browser sign-in produces.
    expect(tesco!["methods"]).toEqual(["cookie"]);
    expect(tesco!["connected"]).toBe(false);
    expect(String(tesco!["reach"])).toMatch(/no public/i);
  });

  it("connecting a store seals the secret and returns metadata only", async () => {
    const res = await panel("/api/connections/sim%3Atesco", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "cookie", secret: "hunter2plaintext" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("hunter2plaintext");
    expect(body).toMatchObject({ ok: true, store_id: "sim:tesco", method: "cookie" });

    expect(vault.reveal("sim:tesco")?.secret).toBe("hunter2plaintext");

    const list = (await (await panel("/api/connections")).json()) as {
      connections: Array<Record<string, unknown>>;
    };
    const tesco = list.connections.find((c) => c["store_id"] === "sim:tesco");
    expect(tesco?.["connected"]).toBe(true);
    expect(JSON.stringify(tesco)).not.toContain("hunter2plaintext");
  });

  it("refuses a store that does not exist", async () => {
    const res = await panel("/api/connections/sim%3Anosuchstore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "token", secret: "whatever-value-here" }),
    });
    expect(res.status).toBe(404);
  });

  it("refuses a method the store's policy does not allow", async () => {
    // A UCP merchant is anonymous: it has no account, so nothing connects.
    const res = await panel("/api/connections/shp%3Aexample.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "cookie", secret: "whatever-value-here" }),
    });
    expect(res.status).toBe(400);
  });

  /*
   * S19 deleted the password path, and this is the test that keeps it deleted.
   * Typing a retailer password into a Basketed form is the shape of every
   * credential-phishing page there is; the browser sign-in replaced it, so no
   * store may offer "password" and the route must refuse it even if one did.
   */
  it("no store offers a password, and the route refuses one outright", async () => {
    for (const store of deps.registry.list()) {
      expect(authPolicyFor(store).methods).not.toContain("password");
    }
    const res = await panel("/api/connections/sim%3Atesco", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "password", username: "me@example.com", secret: "hunter2plaintext" }),
    });
    expect(res.status).toBe(400);
    expect(vault.get("sim:tesco")).toBeNull();
  });

  it("refuses an empty secret", async () => {
    const res = await panel("/api/connections/sim%3Atesco", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "token", secret: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("a cross-origin POST is refused before the token is even checked", async () => {
    const res = await fetch(`${base}/api/connections/sim%3Atesco`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-basketed-token": TOKEN, origin: "http://evil.example" },
      body: JSON.stringify({ method: "token", secret: "whatever-value-here" }),
    });
    expect(res.status).toBe(403);
    expect(vault.get("sim:tesco")).toBeNull();
  });

  it("disconnect forgets it, and forgetting twice says so honestly", async () => {
    await panel("/api/connections/sim%3Acostco", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "cookie", secret: "whatever-value-goes-here" }),
    });
    const first = await panel("/api/connections/sim%3Acostco", { method: "DELETE" });
    expect(first.status).toBe(200);
    expect(vault.get("sim:costco")).toBeNull();

    const second = await panel("/api/connections/sim%3Acostco", { method: "DELETE" });
    expect(second.status).toBe(404);
  });

  it("a broken vault degrades the route to a clear 503, not a 500 or a crash", async () => {
    const broken = { ...deps, vault: degradedVault("disk is full") };
    handler = createPanelHandler(broken, {
      root: ROOT,
      binPath: resolve(ROOT, "packages/cli/bin.js"),
      origin: base,
      endpoint: `${base}/mcp`,
      version: "test",
      token: TOKEN,
    });
    const res = await panel("/api/connections/sim%3Atesco", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "cookie", secret: "whatever-value-here" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/disk is full/);
  });

  it("the Connect-stores page renders once authed, and is locked otherwise", async () => {
    expect((await raw("/connections")).status).toBe(401);
    const html = await (await panel("/connections")).text();
    expect(html).toContain("sim:tesco");
    expect(html).toContain("Connect stores");
  });

  it("the per-store page renders a form, and 404s for an unknown store", async () => {
    const html = await (await panel("/connections/sim%3Atesco")).text();
    expect(html).toContain("Connect Tesco");
    expect((await panel("/connections/sim%3Anosuchstore")).status).toBe(404);
  });
});

/* ------------------------------- connecting in the user's own browser (S20) */

/**
 * The flow the panel actually leads with: a link opens the store in a new tab
 * of the browser the panel is already running in, and the extension -- which
 * lives in that same browser, where Chrome permits reading its own cookies --
 * posts the session back.
 *
 * The claim under test is that the capture route cannot be used as a way to
 * write the vault at will. It needs the panel token like everything else, a
 * store with somewhere to sign in, AND a sign-in the user actually started.
 */
describe("connecting in the user's own browser (S20)", () => {
  it("registering a sign-in is behind the token, and reports where the tab went", async () => {
    const noToken = await raw("/api/connections/sim%3Atesco/browser-connect", {
      method: "POST",
      headers: { origin: base },
    });
    expect(noToken.status).toBe(401);

    const res = await panel("/api/connections/sim%3Atesco/browser-connect", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; url: string; waiting: boolean };
    expect(body).toMatchObject({ ok: true, waiting: true });
    expect(body.url).toMatch(/tesco\.com/);

    const status = (await (await panel("/api/connections/sim%3Atesco/browser-connect")).json()) as {
      waiting: boolean;
    };
    expect(status.waiting).toBe(true);
  });

  it("404s an unknown store and 400s one with no account to sign in to", async () => {
    expect((await panel("/api/connections/sim%3Anope/browser-connect", { method: "POST" })).status).toBe(404);
    expect((await panel("/api/connections/shp%3Aexample.test/browser-connect", { method: "POST" })).status).toBe(400);
  });

  it("a capture with no sign-in in flight is refused -- the vault is not writable on demand", async () => {
    const res = await panel("/api/connections/sim%3Atesco/extension-capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie_header: "at-main=whatever" }),
    });
    expect(res.status).toBe(409);
    expect(vault.get("sim:tesco")).toBeNull();
  });

  it("seals the session the extension read, and never echoes it back", async () => {
    await panel("/api/connections/sim%3Aamazon/browser-connect", { method: "POST" });
    const res = await panel("/api/connections/sim%3Aamazon/extension-capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie_header: "at-main=super-secret-session-value" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("super-secret-session-value");
    expect(body).toMatchObject({ ok: true, store_id: "sim:amazon", method: "cookie" });
    expect(vault.reveal("sim:amazon")?.secret).toBe("at-main=super-secret-session-value");

    // The note is spent: replaying the same POST cannot rewrite the vault.
    const replay = await panel("/api/connections/sim%3Aamazon/extension-capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie_header: "at-main=a-different-value" }),
    });
    expect(replay.status).toBe(409);
    expect(vault.reveal("sim:amazon")?.secret).toBe("at-main=super-secret-session-value");
  });

  it("an empty capture is refused rather than sealed as a connection", async () => {
    await panel("/api/connections/sim%3Aamazon/browser-connect", { method: "POST" });
    const res = await panel("/api/connections/sim%3Aamazon/extension-capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie_header: "   " }),
    });
    expect(res.status).toBe(409);
    expect(vault.get("sim:amazon")).toBeNull();
  });

  /*
   * The extension asks this before it reads a single cookie, because its
   * content script runs on every 127.0.0.1 page and localhost is shared
   * ground. A local page that cannot pass this gets nothing from it.
   */
  it("the extension's proof-of-panel check is the same token gate as everything else", async () => {
    expect((await raw("/api/extension/verify")).status).toBe(401);
    const idle = await panel("/api/extension/verify");
    expect(idle.status).toBe(200);
    // Nothing in flight: no store is named, so there is no jar to open.
    expect(await idle.json()).toEqual({ ok: true, panel: "basketed", pending: [] });

    /*
     * And this is where the extension learns WHICH domains to read: from the
     * server's own pending note, never from the page that asked. A page
     * holding the token still does not get to name the jar it wants opened --
     * "read cookies for X" is a policy decision, and the note is also proof
     * that Connect was pressed on this store minutes ago.
     */
    await panel("/api/connections/sim%3Aamazon/browser-connect", { method: "POST" });
    const live = (await (await panel("/api/extension/verify")).json()) as {
      pending: { store_id: string; domains: string[] }[];
    };
    expect(live.pending).toHaveLength(1);
    expect(live.pending[0]?.store_id).toBe("sim:amazon");
    expect(live.pending[0]?.domains).toContain("amazon.com");
  });

  /*
   * The whole point of S20, asserted on the markup: Connect is a link that
   * opens the retailer in a new tab of THIS browser. A button that scripted
   * a window open would be popup-blocked, and a server-side launch would be
   * a different browser -- which is the complaint this replaced.
   */
  it("Connect is a real link to the retailer, opening in the browser already in use", async () => {
    const html = await (await panel("/connections/sim%3Aamazon")).text();
    const link = /<a[^>]*data-connect-open[^>]*>/.exec(html)?.[0] ?? "";
    expect(link, "no Connect link on the store page").toBeTruthy();
    expect(link).toMatch(/href="https:\/\/www\.amazon\.com/);
    expect(link).toMatch(/target="_blank"/);
    expect(link).toMatch(/rel="noopener noreferrer"/);
    // No form anywhere -- the CSP forbids form-action, every write is a fetch.
    expect(html).not.toMatch(/<form/);
    // The one password field is the optional "keep me signed in" block, and
    // it says where those bytes go before it takes them.
    expect(html).toMatch(/one place only/);
  });
});

/* ------------------------------------------------------- sign-in window (S23) */

describe("the sign-in window (S23)", () => {
  it("unauthenticated start is refused, and never reaches the engine", async () => {
    const res = await raw("/api/connections/sim%3Atesco/login", { method: "POST", headers: { origin: base } });
    expect(res.status).toBe(401);
    expect(sessions.openLogin).not.toHaveBeenCalled();
  });

  it("404s for an unknown store", async () => {
    expect((await panel("/api/connections/sim%3Anosuchstore/login", { method: "POST" })).status).toBe(404);
  });

  it("400s for a store with no account to sign in to", async () => {
    const res = await panel("/api/connections/shp%3Aexample.test/login", { method: "POST" });
    expect(res.status).toBe(400);
    expect(sessions.openLogin).not.toHaveBeenCalled();
  });

  it("opens the window and reports its state", async () => {
    const res = await panel("/api/connections/sim%3Atesco/login", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "waiting" });
    expect(sessions.openLogin).toHaveBeenCalledWith("sim:tesco");
  });

  it("the status poll is behind the token, and leaks nothing but a state word", async () => {
    expect((await raw("/api/connections/sim%3Atesco/login", { headers: { origin: base } })).status).toBe(401);
    vi.mocked(sessions.pollStatus).mockReturnValueOnce({ state: "needs_human", human: "otp", waited_ms: 4200, error: null });
    const body = await (await panel("/api/connections/sim%3Atesco/login")).json();
    expect(body).toEqual({ state: "needs_human", human: "otp", waited_ms: 4200, error: null });
    expect(JSON.stringify(body)).not.toMatch(/cookie|bearer|=/i);
  });

  it("a launch failure (no Chromium) surfaces as 503, not a crash", async () => {
    vi.mocked(sessions.openLogin).mockResolvedValueOnce({ ok: false, error: "Could not open a browser window: chromium missing" });
    const res = await panel("/api/connections/sim%3Atesco/login", { method: "POST" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/chromium missing/);
  });

  it("finish seals what the window holds and echoes only metadata", async () => {
    vi.mocked(sessions.finishLogin).mockResolvedValueOnce({ ok: true, kind: "cookie" });
    const res = await panel("/api/connections/sim%3Atesco/login/finish", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, store_id: "sim:tesco", method: "cookie" });
  });

  it("finish with no window open is a 409, not a 500", async () => {
    expect((await panel("/api/connections/sim%3Atesco/login/finish", { method: "POST" })).status).toBe(409);
    expect((await panel("/api/connections/shp%3Aexample.test/login/finish", { method: "POST" })).status).toBe(400);
  });

  it("cancel closes whatever window is open and says so honestly", async () => {
    vi.mocked(sessions.cancelLogin).mockResolvedValueOnce(true);
    const res = await panel("/api/connections/sim%3Atesco/login", { method: "DELETE" });
    expect(await res.json()).toEqual({ ok: true, closed: true });
  });

  it("the health check is gated and reports a state, and POST asks the profile now", async () => {
    expect((await raw("/api/connections/sim%3Atesco/health", { headers: { origin: base } })).status).toBe(401);
    const live: SessionHealth = { session_state: "live", last_verified_at: 123, reason: "sealed", profile: true };
    vi.mocked(sessions.checkSession).mockResolvedValueOnce(live);
    const res = await panel("/api/connections/sim%3Atesco/health", { method: "POST" });
    expect(await res.json()).toEqual(live);
    expect(sessions.checkSession).toHaveBeenCalledWith("sim:tesco");
    expect(sessions.reloginWithCredentials).not.toHaveBeenCalled();
  });

  it("an expired session with stored details re-signs-in, and may escalate because a human pressed it", async () => {
    vault.connect({ storeId: loginKey("sim:tesco"), kind: "password", username: "me@example.com", secret: "pw" });
    vi.mocked(sessions.checkSession).mockResolvedValueOnce({ ...UNKNOWN, session_state: "expired", profile: true });
    await panel("/api/connections/sim%3Atesco/health", { method: "POST" });
    expect(sessions.reloginWithCredentials).toHaveBeenCalledWith("sim:tesco", { interactive: true });
  });
});

describe("the optional stored email and password (S23)", () => {
  const post = (id: string, body: unknown) =>
    panel(`/api/connections/${encodeURIComponent(id)}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("is behind the token like everything else", async () => {
    const res = await raw("/api/connections/sim%3Atesco/credentials", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.c", password: "x" }),
    });
    expect(res.status).toBe(401);
    expect(vault.get(loginKey("sim:tesco"))).toBeNull();
  });

  it("refuses an empty pair, an unknown store, and a store with no account", async () => {
    expect((await post("sim:tesco", { email: "", password: "" })).status).toBe(400);
    expect((await post("sim:nope", { email: "a@b.c", password: "x" })).status).toBe(404);
    expect((await post("shp:example.test", { email: "a@b.c", password: "x" })).status).toBe(400);
  });

  it("stores them under the login key, echoes the email and never the password", async () => {
    const res = await post("sim:tesco", { email: "me@example.com", password: "hunter2-not-echoed" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(body).toMatchObject({ ok: true, store_id: "sim:tesco", email: "me@example.com" });
    expect(vault.reveal(loginKey("sim:tesco"))?.secret).toBe("hunter2-not-echoed");
    // Not a connection: the store is still "not connected", but the flag is up.
    const list = (await (await panel("/api/connections")).json()) as {
      connections: { store_id: string; connected: boolean; has_login_credentials: boolean }[];
    };
    const tesco = list.connections.find((c) => c.store_id === "sim:tesco")!;
    expect(tesco.connected).toBe(false);
    expect(tesco.has_login_credentials).toBe(true);
    expect(list.connections.some((c) => c.store_id.endsWith("#login"))).toBe(false);
    // And the plain connect route cannot reach the row by its key.
    expect((await panel("/api/connections/sim%3Atesco%23login", { method: "DELETE" })).status).toBe(404);
  });

  it("can be removed", async () => {
    await post("sim:tesco", { email: "me@example.com", password: "x" });
    expect((await panel("/api/connections/sim%3Atesco/credentials", { method: "DELETE" })).status).toBe(200);
    expect(vault.get(loginKey("sim:tesco"))).toBeNull();
    expect((await panel("/api/connections/sim%3Atesco/credentials", { method: "DELETE" })).status).toBe(404);
  });
});

/* ---------------------------------------------------- one card per brand (S23) */

describe("one card per brand (S23)", () => {
  let html: string;
  beforeEach(async () => {
    // Its own registry: the live Tesco and Amazon adapters beside their sample
    // twins, which the shared registry above deliberately leaves out.
    deps.registry.register(new TescoAdapter());
    deps.registry.register(new AmazonAdapter());
    html = await (await panel("/connections")).text();
  });

  it("renders Tesco once, with both mode chips and Connect on the live row", () => {
    const cards = html.match(/<article class="appcard"[^>]*>/g) ?? [];
    const tesco = cards.filter((c) => /data-name="tesco"/.test(c));
    expect(tesco).toHaveLength(1);
    expect(tesco[0]).toMatch(/data-store="tsc:tesco"/);
    expect(tesco[0]).toMatch(/data-live-store="tsc:tesco"/);
    expect(tesco[0]).toMatch(/data-sample-store="sim:tesco"/);
    expect(tesco[0]).toMatch(/data-ids="sim:tesco tsc:tesco"/);
    const card = html.slice(html.indexOf(tesco[0]!), html.indexOf("</article>", html.indexOf(tesco[0]!)));
    expect(card).toMatch(/class="mode live"/);
    expect(card).toMatch(/class="mode sample"/);
    expect(card).toMatch(/data-connect-go/);
    expect(card).not.toMatch(/class="twin"/);
  });

  it("a sample-only brand keeps its Connect, and a brand with no account says so", () => {
    const costco = /<article class="appcard"[^>]*data-name="costco"[^>]*>[\s\S]*?<\/article>/.exec(html)?.[0] ?? "";
    expect(costco).toMatch(/data-store="sim:costco"/);
    expect(costco).toMatch(/data-connect-go/);
    const ucp = /<article class="appcard"[^>]*data-name="example ucp"[^>]*>[\s\S]*?<\/article>/.exec(html)?.[0] ?? "";
    expect(ucp).toMatch(/no account needed/);
  });

  it("the sample twin's page is the live one's page", async () => {
    const res = await panel("/connections/sim%3Atesco", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/connections/tsc%3Atesco");
    expect((await panel("/connections/sim%3Acostco", { redirect: "manual" })).status).toBe(200);
  });
});

/* ------------------------------------------------- shopping mode (S24) */

describe("the shopping-mode setting: basket is on, purchase is greyed out", () => {
  it("state names both modes and marks purchase as locked", async () => {
    const state = (await panel("/api/state").then((r) => r.json())) as {
      shopping_mode: { mode: string; options: Array<{ id: string; available: boolean; locked_reason?: string }> };
    };
    const ids = state.shopping_mode.options.map((o) => o.id);
    expect(ids).toEqual(["basket", "purchase"]);
    const purchaseOpt = state.shopping_mode.options.find((o) => o.id === "purchase")!;
    expect(purchaseOpt.available).toBe(false);
    expect(purchaseOpt.locked_reason).toMatch(/locked/i);
    expect(state.shopping_mode.options.find((o) => o.id === "basket")!.available).toBe(true);
  });

  it("refuses to switch to purchase mode as a lock, and leaves the mode alone", async () => {
    purchase.db.prepare("DELETE FROM settings WHERE k = 'shopping_mode'").run();
    const res = await panel("/api/settings/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "purchase" }),
    });
    expect(res.status).toBe(423);
    const body = (await res.json()) as { locked: boolean; mode: string; error: string };
    expect(body.locked).toBe(true);
    expect(body.mode).toBe("basket");
    expect(loadShoppingMode(purchase.db)).toBe("basket");
  });

  it("takes basket mode, and says an unknown mode is not a lock", async () => {
    const ok = await panel("/api/settings/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "basket" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { mode: string }).mode).toBe("basket");
    expect(loadShoppingMode(purchase.db)).toBe("basket");

    const bad = await panel("/api/settings/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "checkout" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { locked: boolean }).locked).toBe(false);
  });

  it("lists what the agent put in the shopper's basket, without the account handle", async () => {
    const tesco = deps.registry.get("sim:tesco")!;
    const [id] = (await tesco.search({ query: "coffee", maxResults: 1 }, ctx)).map((p) => p.id);
    await addToBasket(purchase, { items: [{ id: id!, quantity: 3 }], accountHandle: "acct_sim_tesco", principal: PRINCIPAL });

    expect((await raw("/api/baskets")).status).toBe(401);
    const body = (await panel("/api/baskets").then((r) => r.json())) as { baskets: Array<Record<string, unknown>> };
    expect(body.baskets).toHaveLength(1);
    expect(body.baskets[0]!["store_id"]).toBe("sim:tesco");
    expect(body.baskets[0]!["summary"]).toHaveLength(1);
    expect(body.baskets[0]!).not.toHaveProperty("account_handle");
    expect(body.baskets[0]!).not.toHaveProperty("cart_json");
  });

  it("the approvals page draws the mode picker and the baskets list", async () => {
    const html = await panel("/approvals").then((r) => r.text());
    expect(html).toContain('id="mode"');
    expect(html).toContain('id="baskets"');
    expect(html).toMatch(/locked in this build/);
  });
});

/* ------------------------- the README does not describe a build we do not have (S15) */

/**
 * README's Security section names Tesco/Costco/Walmart/Amazon as the four
 * stores "Log in with Chrome" covers. That is a fact about `connections.ts`'s
 * policy table, not prose -- so if a fifth store quietly gained (or one of
 * the four lost) Chrome-login coverage, this fails instead of the README
 * silently going stale.
 */
describe("the README does not describe a connect build we do not have (S15, S19)", () => {
  it("names exactly the stores this build can sign in to", async () => {
    const withChromeLogin = deps.registry
      .list()
      .filter((s) => authPolicyFor(s).login)
      .map((s) => s.name)
      .sort();
    expect(withChromeLogin).toEqual(["Amazon", "Costco", "IKEA", "Shopee", "Taobao", "Tesco", "Walmart"]);

    const readme = await readFile(resolve(ROOT, "README.md"), "utf8");
    const bullet = /Connect signs you in at the store[\s\S]{0,4000}?never opens a window when nobody\s+is there\./i.exec(readme)?.[0];
    expect(bullet, "README's connect bullet was not found where expected").toBeTruthy();
    for (const name of [...withChromeLogin, "Target", "Etsy", "eBay", "Best Buy"]) {
      expect(bullet).toMatch(new RegExp(name));
    }
    // The claims the panel's whole connect flow rests on, kept out of drift.
    expect(bullet).toMatch(/one time/i);
    expect(bullet).toMatch(/retailer's own sign-in form/i);
  });
});

