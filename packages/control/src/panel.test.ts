import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StoreRegistry, SimulatedAdapter, TargetAdapter, TescoAdapter, type AdapterCtx } from "@basketed/adapters";
import {
  loadGuardrails,
  openDb,
  prepareCart,
  saveGuardrails,
  type PurchaseDeps,
} from "@basketed/commerce";
import type { FxTable } from "@basketed/core";
import { openVault, degradedVault, decodeSession, encodeSession, type Vault } from "@basketed/vault";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/*
 * Serving a real panel means the verify route really writes its "an extension
 * spoke to a panel" note. Point that at a temporary directory before anything
 * imports the module, so a test run never makes `basketed doctor` claim an
 * extension this machine does not have.
 */
process.env["BASKETED_STATE_DIR"] = mkdtempSync(join(tmpdir(), "basketed-state-"));

import { createPanelHandler } from "./index.js";
import { readExtensionSeen } from "./extension-file.js";
import { authPolicyFor } from "./connections.js";
import { resetHandoff } from "./handoff.js";
import type { ControlDeps } from "./types.js";

/**
 * Chrome-login (S15) is real automation of a real browser -- not something a
 * unit test should actually launch. The route-level contract (auth gating,
 * 400/404/409/503 paths, and that a captured secret never echoes back) is
 * what's under test here; `browser-connect.ts` itself is out of scope.
 */
vi.mock("./browser-connect.js", () => ({
  startLogin: vi.fn(async () => ({ ok: true as const, logged_in: false, attached: false })),
  captureLogin: vi.fn(async () => ({ ok: false as const, error: "not configured for this test" })),
  cancelLogin: vi.fn(async () => false),
  stateOf: vi.fn(() => "idle" as const),
  statusOf: vi.fn(() => ({ state: "idle" as const, logged_in: false, waited_ms: 0 })),
  chromeMode: vi.fn(async () => ({ attached: false, where: "/tmp/basketed-chrome-profile" })),
  closeAll: vi.fn(async () => {}),
}));
import { startLogin, captureLogin, cancelLogin } from "./browser-connect.js";

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
  // Every store with an account now offers the browser sign-in (S19), so the
  // "nothing to connect" routes need a store that genuinely has no account:
  // Target is reached signed-out, through its own public pages.
  registry.register(new TargetAdapter());
  // Real Tesco is the one store whose credential is a header SET rather than a
  // single value, so the session tests need it registered.
  registry.register(new TescoAdapter());
  const tesco = registry.get("sim:tesco")!;
  const productIds = (await tesco.search({ query: "coffee", maxResults: 2 }, ctx)).map((p) => p.id);

  const fx = JSON.parse(await readFile(resolve(ROOT, "fixtures/fx.json"), "utf8")) as FxTable;
  purchase = { db: openDb(":memory:"), registry, ctx, fx, announce: () => {} };
  saveGuardrails(purchase.db, { homeCurrency: "GBP", perOrderCap: 1000, dailyCap: 5000 });

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
  };
  vault = deps.vault;

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
    // Target is reached signed-out: it has no account, so nothing connects.
    const res = await panel("/api/connections/tgt%3Atarget", {
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
    expect((await panel("/api/connections/tgt%3Atarget/browser-connect", { method: "POST" })).status).toBe(400);
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
    const ok = await panel("/api/extension/verify");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, panel: "basketed" });
  });

  /*
   * `basketed doctor` runs in its own process, long after the handshake it
   * wants to report on, so the handshake has to leave a mark. Without this,
   * the single most common reason Connect does nothing -- the extension is
   * not loaded -- was the one thing doctor could not check (S24).
   */
  it("a verified extension leaves a note doctor can read, with its version", async () => {
    const ok = await panel("/api/extension/verify/1.1.0");
    expect(ok.status).toBe(200);
    const seen = readExtensionSeen();
    expect(seen?.version).toBe("1.1.0");
    expect(seen?.seenAt).toBeGreaterThan(0);
  });

  /* An older extension asks for the bare path. It is still answered. */
  it("answers an extension that reports no version at all", async () => {
    expect((await panel("/api/extension/verify")).status).toBe(200);
  });

  /*
   * The note is a timestamp and a version string. A token in it would be a
   * credential sitting in a directory every process the user runs can read --
   * the exact thing panel.json refuses to do, for the same reason.
   */
  it("the note holds no secret", async () => {
    await panel("/api/extension/verify/1.1.0");
    const note = await readFile(resolve(process.env["BASKETED_STATE_DIR"]!, "extension.json"), "utf8");
    expect(note).not.toContain(TOKEN);
    expect(JSON.parse(note)).toEqual({ seenAt: expect.any(Number), version: "1.1.0" });
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
    // Nothing on this page collects a credential, in any form.
    expect(html).not.toMatch(/type="password"/);
    expect(html).not.toMatch(/<form/);
  });

  /*
   * The extension's absence has to be visible BEFORE the click (S24).
   *
   * The page used to keep its only mention of the extension in a hidden block
   * that appeared after a connect had already gone nowhere -- so the most
   * common reason Connect does nothing was invisible until it had already
   * wasted the reader's time. The badge is rendered on the server and filled
   * in by the script on load, and the how-to now carries the absolute folder
   * path, because "load packages/extension" is not a thing anyone can paste.
   */
  it("says whether the extension is loaded before anything is pressed", async () => {
    const html = await (await panel("/connections/sim%3Aamazon")).text();
    expect(html).toContain("data-ext-badge");
    expect(html).toContain("data-ext-pill");
    // Backslash or forward slash: the path is whatever this platform writes.
    expect(html).toMatch(/packages[\\/]extension/);
    expect(html).toContain("Load unpacked");
  });

  /*
   * A left click has to be handled by the page, not left to the anchor: only
   * a window this page opened itself can be closed by it, and closing it is
   * the difference between "connected" and "connected, and now go tidy up".
   * The anchor stays an anchor so middle-click still works.
   */
  it("the panel script takes a window handle so it can close the tab it opened", async () => {
    const js = await (await panel("/connections/sim%3Aamazon")).text();
    expect(js).toContain("window.open(");
    expect(js).toContain("openedTabs");
    expect(js).toContain("closeTab");
    // ...and provokes a tab that is signed in but silent, rather than waiting
    // on a request an idle page is never going to make.
    expect(js).toContain("no-headers");
  });
});

/* ------------------------------------ sessions that are more than one header (S21) */

/** A JWT with the given expiry, unsigned -- nothing here verifies it. */
function bearerExpiring(exp: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `Bearer ${b64({ alg: "none" })}.${b64({ exp })}.sig`;
}

describe("a store whose credential is a header set (S21)", () => {
  it("seals every header the store named, with the session's expiry", async () => {
    const token = bearerExpiring(1_800_000_000);
    await panel("/api/connections/tsc%3Atesco/browser-connect", { method: "POST" });
    const res = await panel("/api/connections/tsc%3Atesco/extension-capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cookie_header: "junk=1",
        headers: { authorization: token, "customer-uuid": "uuid-999" },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, store_id: "tsc:tesco", method: "session" });
    // Neither header may come back out of the route that just took them in.
    expect(JSON.stringify(body)).not.toContain("uuid-999");
    expect(JSON.stringify(body)).not.toContain(token);

    const held = vault.get("tsc:tesco");
    expect(held?.expiresAt).toBe(1_800_000_000_000);
    expect(held?.expired).toBe(false);

    const session = decodeSession(vault.reveal("tsc:tesco")!.secret)!;
    expect(session.headers["authorization"]).toBe(token);
    expect(session.headers["customer-uuid"]).toBe("uuid-999");
    // Renewable without asking the human again -- see SessionSecret.refresh.
    expect(session.refresh).toEqual({ via: "browser", storeId: "tsc:tesco" });
  });

  it("refuses a capture missing a header the store requires, and names the missing one", async () => {
    await panel("/api/connections/tsc%3Atesco/browser-connect", { method: "POST" });
    const res = await panel("/api/connections/tsc%3Atesco/extension-capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie_header: "junk=1", headers: { authorization: "Bearer x" } }),
    });
    // Sealing half a session looks like success here and fails at the first
    // basket call, which is the exact failure this whole change removes.
    expect(res.status).toBe(409);
    expect(String(((await res.json()) as { error: string }).error)).toMatch(/customer-uuid/);
    expect(vault.get("tsc:tesco")).toBeNull();
  });

  it("a store with no header set still seals its cookie jar", async () => {
    await panel("/api/connections/sim%3Aamazon/browser-connect", { method: "POST" });
    const res = await panel("/api/connections/sim%3Aamazon/extension-capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie_header: "at-main=still-a-cookie-store" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ method: "cookie" });
  });
});

/**
 * A session that has run out is not a connection. The panel showing it green
 * is the specific lie this covers: the user finds out at the checkout, from
 * the retailer, instead of here.
 */
describe("a session that has expired (S23)", () => {
  it("reports an expired session as expired, and NOT as connected", async () => {
    vault.connect({
      storeId: "sim:amazon",
      kind: "session",
      username: null,
      secret: encodeSession({ headers: { authorization: "Bearer x" }, expiresAt: 1_000 }),
    });
    const list = (await (await panel("/api/connections")).json()) as {
      connections: Array<Record<string, unknown>>;
    };
    const amazon = list.connections.find((c) => c["store_id"] === "sim:amazon");
    expect(amazon).toMatchObject({ connected: false, expired: true, expires_at: 1_000 });
  });

  it("a session with runway left is connected, and says when it runs out", async () => {
    const future = Date.now() + 3_600_000;
    vault.connect({
      storeId: "sim:amazon",
      kind: "session",
      username: null,
      secret: encodeSession({ headers: { authorization: "Bearer x" }, expiresAt: future }),
    });
    const list = (await (await panel("/api/connections")).json()) as {
      connections: Array<Record<string, unknown>>;
    };
    const amazon = list.connections.find((c) => c["store_id"] === "sim:amazon");
    expect(amazon).toMatchObject({ connected: true, expired: false, expires_at: future });
  });

  it("a credential with no expiry at all is connected with no clock on it", async () => {
    vault.connect({ storeId: "sim:amazon", kind: "cookie", username: null, secret: "at-main=x" });
    const list = (await (await panel("/api/connections")).json()) as {
      connections: Array<Record<string, unknown>>;
    };
    const amazon = list.connections.find((c) => c["store_id"] === "sim:amazon");
    expect(amazon).toMatchObject({ connected: true, expired: false, expires_at: null });
  });
});

/* -------------------------------------------------------- chrome-login (S15) */

describe("chrome-login (S15)", () => {
  beforeEach(() => {
    vi.mocked(startLogin).mockReset().mockResolvedValue({ ok: true, logged_in: false, attached: false });
    vi.mocked(captureLogin).mockReset();
    vi.mocked(cancelLogin).mockReset().mockResolvedValue(false);
  });

  it("unauthenticated start is refused, and never reaches the launcher", async () => {
    // Same-origin header, no token -- isolates the token check from the Origin check.
    const res = await raw("/api/connections/sim%3Atesco/chrome-login", {
      method: "POST",
      headers: { origin: base },
    });
    expect(res.status).toBe(401);
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("404s for an unknown store", async () => {
    const res = await panel("/api/connections/sim%3Anosuchstore/chrome-login", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("400s for a store with no account to sign in to", async () => {
    const res = await panel("/api/connections/tgt%3Atarget/chrome-login", { method: "POST" });
    expect(res.status).toBe(400);
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("starts a login window and reports waiting", async () => {
    const res = await panel("/api/connections/sim%3Atesco/chrome-login", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, waiting: true, logged_in: false, attached: false });
    // The launcher is handed the whole target: where to land, where to send a
    // signed-out shopper, and the signatures that say the sign-in finished.
    expect(startLogin).toHaveBeenCalledWith(
      "sim:tesco",
      expect.objectContaining({
        url: expect.stringContaining("tesco.com"),
        loginUrl: expect.stringContaining("login"),
        domains: ["tesco.com"],
        authCookies: expect.arrayContaining(["_ttoken"]),
      }),
    );
  });

  it("reports login status for the open window, and leaks no cookie", async () => {
    const res = await panel("/api/connections/sim%3Atesco/chrome-login");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ state: "idle", logged_in: false, waited_ms: 0 });
    // The status poll is reachable by anything holding the token, so it must
    // never become a way to read the session it is reporting on.
    expect(JSON.stringify(body)).not.toMatch(/cookie|token|=/i);
  });

  it("the status poll is behind the token like every other route", async () => {
    const res = await raw("/api/connections/sim%3Atesco/chrome-login", {
      headers: { origin: base },
    });
    expect(res.status).toBe(401);
  });

  it("a launch failure (no Chrome installed) surfaces as 503, not a crash", async () => {
    vi.mocked(startLogin).mockResolvedValueOnce({ ok: false, error: "Google Chrome was not found on this machine." });
    const res = await panel("/api/connections/sim%3Atesco/chrome-login", { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Chrome was not found/);
  });

  it("capture seals a cookie credential and never echoes the raw session back", async () => {
    vi.mocked(captureLogin).mockResolvedValueOnce({
      ok: true,
      cookieHeader: "session=super-secret-cookie-value",
      headers: {},
    });
    const res = await panel("/api/connections/sim%3Atesco/chrome-login/capture", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("super-secret-cookie-value");
    expect(body).toMatchObject({ ok: true, store_id: "sim:tesco", method: "cookie" });
    expect(vault.reveal("sim:tesco")?.secret).toBe("session=super-secret-cookie-value");
    expect(captureLogin).toHaveBeenCalledWith("sim:tesco", ["tesco.com"]);
  });

  it("a capture with no window open, or no cookies yet, is a 409, not a 500", async () => {
    vi.mocked(captureLogin).mockResolvedValueOnce({
      ok: false,
      error: "No sign-in tab is open for this store. Press Connect first.",
    });
    const res = await panel("/api/connections/sim%3Atesco/chrome-login/capture", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("400s a capture for a store with no account to sign in to", async () => {
    const res = await panel("/api/connections/tgt%3Atarget/chrome-login/capture", { method: "POST" });
    expect(res.status).toBe(400);
    expect(captureLogin).not.toHaveBeenCalled();
  });

  it("cancel closes whatever window is open and says so honestly", async () => {
    vi.mocked(cancelLogin).mockResolvedValueOnce(true);
    const res = await panel("/api/connections/sim%3Atesco/chrome-login", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, closed: true });
  });

  it("a broken vault degrades capture to a clear 503, not a lost session", async () => {
    vi.mocked(captureLogin).mockResolvedValueOnce({ ok: true, cookieHeader: "session=abc", headers: {} });
    const broken = { ...deps, vault: degradedVault("disk is full") };
    handler = createPanelHandler(broken, {
      root: ROOT,
      binPath: resolve(ROOT, "packages/cli/bin.js"),
      origin: base,
      endpoint: `${base}/mcp`,
      version: "test",
      token: TOKEN,
    });
    const res = await panel("/api/connections/sim%3Atesco/chrome-login/capture", { method: "POST" });
    expect(res.status).toBe(503);
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
    // Deduped by name on purpose: the README names RETAILERS, and Tesco is
    // reachable under two store ids -- the simulated one and the real one --
    // both of which connect.
    const withChromeLogin = [
      ...new Set(
        deps.registry
          .list()
          .filter((s) => authPolicyFor(s).chromeLogin)
          .map((s) => s.name),
      ),
    ].sort();
    expect(withChromeLogin).toEqual(["Amazon", "Costco", "IKEA", "Shopee", "Taobao", "Tesco", "Walmart"]);

    const readme = await readFile(resolve(ROOT, "README.md"), "utf8");
    const bullet = /Connect signs you in at the store[\s\S]{0,3000}?asked for by hand\./i.exec(readme)?.[0];
    expect(bullet, "README's connect bullet was not found where expected").toBeTruthy();
    for (const name of withChromeLogin) {
      expect(bullet).toMatch(new RegExp(name));
    }
    // The claim the panel's whole connect flow rests on, kept out of drift.
    expect(bullet).toMatch(/no field anywhere that accepts a retailer password/i);
  });
});

