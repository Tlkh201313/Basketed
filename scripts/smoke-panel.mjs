#!/usr/bin/env node
/**
 * Approval channel A, over HTTP, against the real server (§6, §11 step 8).
 *
 * The point being proved is that the panel is a SEPARATE channel: a cart is
 * prepared over MCP, approved over the REST API with a typed total, and only
 * then does the MCP confirm succeed. Nothing the agent said approved it.
 *
 * Runs against the simulated stores, so it works with the cable out.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_DIR = mkdtempSync(join(tmpdir(), "basketed-panel-"));

let failures = 0;
function check(label, condition, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  if (!condition) failures += 1;
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

const child = spawn(
  process.execPath,
  [resolve(ROOT, "packages/cli/bin.js"), "serve", "--http", "--port", String(PORT), "--snapshots"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BASKETED_DB: join(DB_DIR, "panel.db") } },
);

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => {
  stderr += d;
});

// Wait for the listen banner rather than sleeping a fixed amount.
await new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error(`server never listened:\n${stderr}`)), 20_000);
  const tick = setInterval(() => {
    if (stderr.includes("MCP endpoint")) {
      clearInterval(tick);
      clearTimeout(timer);
      res();
    }
  }, 100);
});

/*
 * The panel token is printed on the banner and nowhere else. Reading it here is
 * exactly the move a human makes: look at the server's own console. An agent
 * speaking MCP over the socket has no equivalent.
 */
const TOKEN = (/panel\s+\S+\?t=([A-Za-z0-9_-]+)/.exec(stderr) ?? [])[1] ?? "";

let rpcId = 1;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "Mcp-Method": method,
      "Mcp-Name": typeof params?.name === "string" ? params.name : "",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method,
      params: {
        ...(params ?? {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "basketed-panel-smoke", version: "0.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  // A modern exchange may come back as SSE; take the last data: frame.
  const line = text.includes("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).pop().slice(5).trim()
    : text;
  return JSON.parse(line);
}

async function call(name, args) {
  const res = await rpc("tools/call", { name, arguments: args ?? {} });
  const body = res.result?.structuredContent ?? JSON.parse(res.result?.content?.[0]?.text ?? "{}");
  return { isError: Boolean(res.result?.isError), data: body };
}

const api = async (path, init) => {
  const opts = init ?? {};
  const method = (opts.method ?? "GET").toUpperCase();
  // Defaults first, so an explicit header in a negative test still wins.
  const headers = {
    "x-basketed-token": TOKEN,
    ...(method === "GET" ? {} : { origin: BASE }),
    ...(opts.headers ?? {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  console.log("\n── the approval surface is behind a token ───────────────────");

  check("the banner printed a panel token", TOKEN.length >= 32, `${TOKEN.length} chars`);

  // The whole point. Basketed installs into agents that have a shell, so the
  // gate has to be something a local process cannot read -- not a header it
  // can simply decline to send.
  const bare = await fetch(`${BASE}/api/approvals`);
  check("an unauthenticated GET /api is 401", bare.status === 401);

  const bareApprove = await fetch(`${BASE}/api/approvals/whatever/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ typed_total: "1.00" }),
  });
  check("an unauthenticated approve is 401", bareApprove.status === 401);

  const bareGuardrails = await fetch(`${BASE}/api/guardrails`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ per_order_cap: 999999 }),
  });
  check("an unauthenticated guardrail write is 401", bareGuardrails.status === 401);

  // Every browser sends an Origin. Absent means the caller is not a browser,
  // and a non-browser has to come through the token instead.
  const noOrigin = await fetch(`${BASE}/api/approvals/whatever/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-basketed-token": TOKEN },
    body: JSON.stringify({ typed_total: "1.00" }),
  });
  check("a mutating call with NO Origin is refused", noOrigin.status === 403);

  const locked = await fetch(`${BASE}/approvals`);
  const lockedHtml = await locked.text();
  check("an unauthenticated panel page is locked", locked.status === 401);
  check("the locked page leaks no token", !lockedHtml.includes(TOKEN));
  console.log("\n── panel serves ───────────────────────────────────────────────────");

  const home = await fetch(`${BASE}/?t=${TOKEN}`);
  const html = await home.text();
  check("GET / serves the install page", home.status === 200 && html.includes("basket"));
  check("the page names the endpoint", html.includes(`${BASE}/mcp`));
  check("the page states fast-mode's scope", /not reachable from/i.test(html));
  // The panel parses the published figures out of docs/BENCHMARK.md rather
  // than carrying its own copy. If that parse breaks, the panel must not quote
  // a number it did not read.
  check("the headline figures came from BENCHMARK.md", /\d+\.\d+%<\/b><span>fewer tokens/.test(html), (html.match(/<b>([\d.]+%)<\/b>/g) ?? []).join(" "));
  check("the tool-definition overhead is a real number", /[\d,]+-token tool-definition/.test(html), (html.match(/([\d,]+)-token/) ?? [])[1]);
  check("a CSP is set on the approval surface", Boolean(home.headers.get("content-security-policy")));

  const approvalsPage = await fetch(`${BASE}/approvals?t=${TOKEN}`);
  check("GET /approvals serves", approvalsPage.status === 200);

  const state = await api("/api/state");
  check("GET /api/state answers", state.status === 200, `${state.body?.stores?.length} stores`);
  check("state never contains a token or code", !/sk_|Bearer |code_hash/.test(JSON.stringify(state.body)));

  console.log("\n── channel A: prepare over MCP, approve in the panel ───────────────");

  const search = await call("basket_search_products", { query: "coffee", stores: ["sim:tesco"], max_results: 2 });
  const product = search.data?.results?.[0];
  check("MCP search works over HTTP", Boolean(product?.id), product?.id ?? "none");

  const prepared = await call("basket_cart_prepare", {
    items: [{ id: product.id, quantity: 1 }],
    account_handle: "acct_guest_sim_tesco",
  });
  const approvalId = prepared.data?.approval_id;
  check("cart_prepare minted an approval", Boolean(approvalId));

  const pending = await api("/api/approvals");
  const card = pending.body?.approvals?.[0];
  check("the panel lists it as pending", card?.id === approvalId);
  check("the card itemises the cart", (card?.line_items?.length ?? 0) > 0);
  check("the card carries a live countdown", (card?.expires_in_ms ?? 0) > 0);
  check(
    "the card carries NO vendor prose",
    !/description|review|<script/i.test(JSON.stringify(card ?? {})),
    "no merchant-authored string reaches the approval screen",
  );

  const beforeApproval = await call("basket_purchase_confirm", { approval_id: approvalId });
  check("confirm before the human clicks is refused", beforeApproval.isError === true);

  const wrongTotal = await api(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ typed_total: "1.00" }),
  });
  check("a WRONG typed total is refused", wrongTotal.status === 409, wrongTotal.body?.reason);

  const right = card.total.value.toFixed(2);
  const approved = await api(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ typed_total: right }),
  });
  check("the CORRECT typed total approves", approved.status === 200 && approved.body?.ok === true, `${right} ${card.total.currency}`);

  const confirmed = await call("basket_purchase_confirm", { approval_id: approvalId });
  check("MCP confirm now succeeds, once", confirmed.isError === false, `${confirmed.data?.state}/${confirmed.data?.outcome}`);

  const replay = await call("basket_purchase_confirm", { approval_id: approvalId });
  check("replay is still refused", replay.isError === true);

  const gone = await api("/api/approvals");
  check("the approval leaves the pending list", (gone.body?.approvals ?? []).length === 0);

  const orders = await api("/api/orders");
  check("the order shows in the panel", (orders.body?.orders ?? []).some((o) => o.id === confirmed.data?.order_id));

  console.log("\n── the panel refuses what it should ───────────────────────────────");

  const crossOrigin = await api(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, {
    method: "POST",
    headers: { origin: "http://evil.example" },
  });
  check("a cross-origin POST is refused", crossOrigin.status === 403);

  const badOutcome = await api(`/api/orders/${encodeURIComponent(confirmed.data?.order_id)}/outcome`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: "DELIVERED" }),
  });
  check("an arbitrary order state is refused", badOutcome.status === 400);

  const simOutcome = await api(`/api/orders/${encodeURIComponent(confirmed.data?.order_id)}/outcome`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: "CONFIRMED" }),
  });
  // Only a HANDED_OFF order can be moved by a human. A simulated order is
  // already terminal and must not be promotable to a real-looking state.
  check("a simulated order cannot be talked into CONFIRMED", simOutcome.status === 409);

  const mcpCrossOrigin = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
  });
  check("a cross-origin POST to /mcp is refused", mcpCrossOrigin.status === 403);

  const missing = await fetch(`${BASE}/nope`);
  check("unknown routes 404", missing.status === 404);
} finally {
  child.kill();
  await new Promise((res) => child.once("exit", res));
  try {
    rmSync(DB_DIR, { recursive: true, force: true });
  } catch {
    // A leftover temp file is not a test failure.
  }
}

console.log(failures === 0 ? "\nPanel + channel A verified end to end.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
