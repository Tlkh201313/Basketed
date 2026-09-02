#!/usr/bin/env node
/**
 * The wifi-failure drill (§11), with the network genuinely severed.
 *
 *   node scripts/drill-offline.mjs
 *
 * §11 says to set BASKETED_SNAPSHOTS=1 and pull the cable, and that steps 1, 3,
 * 4, 5, 6, 7, 8, 9, 10 and 11 must all pass. Running that with the wifi up
 * proves nothing — the flag could be ignored and every check would still be
 * green off the wire. So the server here is started behind scripts/offline-
 * guard.mjs, which refuses every non-loopback connection in the child process.
 * If any part of the demo path secretly needs the internet, this fails.
 *
 * Only three of the ten pinned Shopify stores have a Day-0 snapshot. The other
 * seven are SUPPOSED to fail here, and the drill asserts they are named as
 * unavailable rather than quietly vanishing from the results.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const GUARD = pathToFileURL(resolve(ROOT, "scripts/offline-guard.mjs")).href;
const PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_DIR = mkdtempSync(join(tmpdir(), "basketed-drill-"));

/** Captured at Day-0. Everything else is expected to be dark. */
let SNAPSHOTTED;
try {
  const pinned = JSON.parse(readFileSync(resolve(ROOT, "fixtures/stores.pinned.json"), "utf8"));
  SNAPSHOTTED = pinned.stores.slice(0, 3).map((s) => `shp:${s.domain}`);
} catch {
  SNAPSHOTTED = ["shp:deathwishcoffee.com", "shp:chubbiesshorts.com", "shp:tonyschocolonely.com"];
}
const CART_STORE = "shp:deathwishcoffee.com";

let failures = 0;
function check(label, condition, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  if (!condition) failures += 1;
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}
function step(n, title) {
  console.log(`\n── §11 step ${n} · ${title} ${"─".repeat(Math.max(0, 52 - title.length))}`);
}

/* ---------------------------------------------------- positive control */

console.log("\n── the guard itself ───────────────────────────────────────────────");

const selftest = await new Promise((res) => {
  const p = spawn(process.execPath, ["--import", GUARD, "-e", ""], {
    env: { ...process.env, BASKETED_GUARD_SELFTEST: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let out = "";
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (d) => (out += d));
  p.once("exit", () => res(out));
});
check("the guard installs", selftest.includes("[offline-guard] armed"));
check(
  "a real outbound request is genuinely blocked",
  selftest.includes("selftest: blocked") && !selftest.includes("LEAKED"),
  "so a green drill below means something",
);

/* ------------------------------------------------------ the server, offline */

const child = spawn(
  process.execPath,
  [resolve(ROOT, "packages/cli/bin.js"), "serve", "--http", "--port", String(PORT)],
  {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import "${GUARD}"`.trim(),
      BASKETED_SNAPSHOTS: "1",
      BASKETED_SIMULATED: "1",
      BASKETED_DB: join(DB_DIR, "drill.db"),
      // The drill reaches an approval, and opening a browser mid-drill would be
      // both a surprise and a second thing to explain on stage.
      BASKETED_NO_OPEN: "1",
      // No Chromium either. With the wire cut a stealth render can only end in
      // a launch or a navigation failure, and spending thirty seconds arriving
      // at one is not a test of anything.
      BASKETED_NO_BROWSER: "1",
    },
  },
);

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => {
  stderr += d;
});

await new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error(`server never listened:\n${stderr}`)), 25_000);
  const tick = setInterval(() => {
    if (stderr.includes("MCP endpoint")) {
      clearInterval(tick);
      clearTimeout(timer);
      res();
    }
  }, 100);
});

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
          "io.modelcontextprotocol/clientInfo": { name: "basketed-drill", version: "0.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
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
// The panel token is printed on the server's own banner and nowhere else --
// the same surface the approval code goes to. Reading it here is what a human
// does; an agent speaking MCP over the socket has no equivalent.
const TOKEN = (/panel\s+\S+\?t=([A-Za-z0-9_-]+)/.exec(stderr) ?? [])[1] ?? "";
const api = async (path, init) => {
  const opts = init ?? {};
  const method = (opts.method ?? "GET").toUpperCase();
  const headers = {
    "x-basketed-token": TOKEN,
    ...(method === "GET" ? {} : { origin: BASE }),
    ...(opts.headers ?? {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  return { status: res.status, body: await res.json().catch(() => null) };
};
function codeFrom(banner) {
  return (banner.match(/APPROVAL CODE: (\d{3}) (\d{3})/) ?? []).slice(1).join("");
}

try {
  step(1, "it starts and serves");
  check("the guard is armed inside the server", stderr.includes("[offline-guard] armed"));
  check("the server says it is replaying snapshots", /\[SNAPSHOTS\]/.test(stderr), "so nobody misreads this run as live");
  check("the banner printed a panel token", TOKEN.length >= 32, "the approval surface is behind it");
  const home = await fetch(`${BASE}/?t=${TOKEN}`);
  check("the panel serves with no wire", home.status === 200);
  const locked = await fetch(`${BASE}/approvals`);
  check("and refuses a caller without it", locked.status === 401, "no token, no approval surface");
  const { ALL_TOOL_NAMES } = await import(pathToFileURL(resolve(ROOT, "packages/mcp/dist/server.js")).href);
  const tools = await rpc("tools/list", {});
  const served = (tools.result?.tools ?? []).map((t) => t.name).sort();
  const expected = [...ALL_TOOL_NAMES].sort();
  check(
    "MCP answers with no wire — every declared tool, and nothing else",
    served.length === expected.length && served.every((n, i) => n === expected[i]),
    `${served.length} tools`,
  );

  step(3, "search — real and simulated side by side");
  const search = await call("basket_search_products", { query: "coffee", max_results: 8 });
  const rows = search.data?.results ?? [];
  const native = rows.filter((r) => r.mode === "native");
  const sim = rows.filter((r) => r.mode === "simulated");
  check("results come back", rows.length > 0, `${rows.length} rows`);
  check("real and simulated appear together", native.length > 0 && sim.length > 0, `${native.length} native, ${sim.length} simulated`);
  check("every row still carries its mode", rows.every((r) => r.mode));
  check(
    "every native row came from a snapshotted store",
    native.every((r) => SNAPSHOTTED.some((id) => id.endsWith(r.source) || id.includes(r.source))),
    [...new Set(native.map((r) => r.source))].join(", "),
  );
  // The seven stores with no Day-0 snapshot must be reported, not swallowed.
  // A search that quietly returns fewer stores than it queried is the failure
  // mode this drill exists to catch: on stage it looks identical to success.
  const down = search.data?.stores_failed ?? [];
  check("the stores it could not reach are NAMED", down.length > 0, `${down.length} reported in stores_failed`);
  check(
    "...and every one of them is a store with no Day-0 snapshot",
    down.every((f) => !SNAPSHOTTED.includes(f.store)),
    down.map((f) => f.store.replace("shp:", "")).join(", "),
  );

  step(4, "detail — and the decimal point");
  const target = native.find((r) => CART_STORE.includes(r.source)) ?? native[0];
  const detail = await call("basket_get_product_detail", { id: target.id, include: ["description", "stock"] });
  check("tier-2 detail resolves offline", detail.isError === false && detail.data?.id === target.id);
  check("the price survives the round trip", detail.data?.price?.value === target.price.value, `${detail.data?.price?.value} ${detail.data?.price?.currency}`);
  check("it is not off by a hundred", detail.data?.price?.value > 0 && detail.data?.price?.value < 1000, "integer minor units, §4 fact 6");

  step(5, "token report");
  const report = await call("basket_get_token_report", {});
  check("the report counted this session", (report.data?.calls ?? 0) > 0, `${report.data?.calls} calls`);
  check("baseline is bytes actually served", report.data?.tokens_baseline > report.data?.tokens_served, `${report.data?.saved_pct}% saved`);

  step(6, "cart_prepare — a real cart, from the snapshot");
  const beforeBanner = stderr.length;
  const prepared = await call("basket_cart_prepare", {
    items: [{ id: target.id, quantity: 1 }],
    account_handle: `acct_guest_${target.source.toLowerCase().replace(/\W+/g, "_")}`,
  });
  const mandate = prepared.data;
  check("a cart was built with no wire", prepared.isError === false && Boolean(mandate?.approval_id), mandate?.store_id);
  check("nothing was charged", mandate?.charged === false);
  const lineSum = (mandate?.line_items ?? []).reduce((n, li) => n + li.unitPrice.value * li.quantity, 0);
  const gap = Number((mandate.total.value - lineSum).toFixed(2));
  // Reconcile by AMOUNT, never by keyword: an earlier version of this check
  // looked for /discount|sale|off/ in the summary and passed on the word
  // "Coffee". Every gap between the lines and the total must be carried by an
  // adjustment line the human can actually read, for exactly that figure.
  const named = (mandate.summary ?? []).find((s) =>
    [...s.matchAll(/-?\d+\.\d{2}/g)].some((m) => Math.abs(Number(m[0]) - gap) < 0.011),
  );
  check(
    "the lines account for the total the human is shown",
    Math.abs(gap) < 0.011 || Boolean(named),
    `lines ${lineSum.toFixed(2)} vs total ${mandate.total.value.toFixed(2)}${gap ? ` — ${named ?? "UNEXPLAINED GAP"}` : ""}`,
  );

  step(7, "channel C — the console code");
  const banner = stderr.slice(beforeBanner);
  const code = codeFrom(banner);
  check("the code printed on the server's own console", code.length === 6);
  // The framed block is what a person reads: the total, and the code to read
  // out. Since S13 the console ALSO carries a deep link to this approval,
  // because the panel now runs alongside stdio -- that line has the id and the
  // panel token in it, which is fine on a console no agent can read, and must
  // never have the code in it.
  const framed = banner.slice(banner.indexOf("=========="), banner.lastIndexOf("==========") + 10);
  check("the framed banner never prints the approval id", !framed.includes(mandate.approval_id));
  const summonLine = banner.split("\n").find((l) => l.includes("approve here")) ?? "";
  check("a link to this approval reached the console", summonLine.includes(mandate.approval_id), summonLine.trim());
  check("...and that link does not carry the code", code.length === 6 && !summonLine.includes(code));
  const noCode = await call("basket_purchase_confirm", { approval_id: mandate.approval_id });
  check("confirm without the human is refused", noCode.isError === true);
  const wrongCode = await call("basket_purchase_confirm", { approval_id: mandate.approval_id, code: "000000" });
  check("a wrong code is refused", wrongCode.isError === true);

  step(9, "purchase_confirm — and what it refuses to claim");
  const confirmed = await call("basket_purchase_confirm", { approval_id: mandate.approval_id, code });
  check("the code approves it", confirmed.isError === false, `${confirmed.data?.state}/${confirmed.data?.outcome}`);
  check(
    "a hand-off says the outcome is UNKNOWN",
    confirmed.data?.state === "HANDED_OFF" && confirmed.data?.outcome === "unknown",
    "never rendered as Ordered — §6 invariant 6",
  );
  check("the hand-off URL came from the snapshot", /^https:\/\//.test(confirmed.data?.handoff_url ?? ""), confirmed.data?.handoff_url?.slice(0, 58));
  const replay = await call("basket_purchase_confirm", { approval_id: mandate.approval_id, code });
  check("replay is refused", replay.isError === true);

  step(10, "order status stays honest");
  const status = await call("basket_get_order_status", { order_id: confirmed.data?.order_id });
  check("it reports handed off, outcome unknown", status.data?.state === "HANDED_OFF" && status.data?.outcome === "unknown");
  check("it leaks no cart json and no approval id", !/cart_json|approval_id/.test(JSON.stringify(status.data)));

  step(8, "channel A — the panel, typed total");
  const simSearch = await call("basket_search_products", { query: "coffee", stores: ["sim:tesco"], max_results: 2 });
  const simProduct = simSearch.data?.results?.[0];
  const second = await call("basket_cart_prepare", {
    items: [{ id: simProduct.id, quantity: 1 }],
    account_handle: "acct_guest_sim_tesco",
  });
  const pending = await api("/api/approvals");
  const card = (pending.body?.approvals ?? []).find((a) => a.id === second.data?.approval_id);
  check("the panel lists it, itemised", Boolean(card) && (card?.line_items?.length ?? 0) > 0);
  const wrong = await api(`/api/approvals/${encodeURIComponent(card.id)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ typed_total: "1.00" }),
  });
  check("a wrong typed total is refused", wrong.status === 409);
  const ok = await api(`/api/approvals/${encodeURIComponent(card.id)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ typed_total: card.total.value.toFixed(2) }),
  });
  check("the correct typed total approves", ok.status === 200 && ok.body?.ok === true, `${card.total.value.toFixed(2)} ${card.total.currency}`);
  const simConfirm = await call("basket_purchase_confirm", { approval_id: card.id });
  check("confirm then succeeds", simConfirm.isError === false, `${simConfirm.data?.state}/${simConfirm.data?.outcome}`);

  console.log("\n── nothing leaked to the wire ─────────────────────────────────────");
  const refusals = [...stderr.matchAll(/\[offline-guard\] refused (?:fetch|TCP) (\S+)/g)].map((m) => m[1]);
  const unexpected = refusals.filter((h) => SNAPSHOTTED.some((id) => id.includes(h)));
  check(
    "no snapshotted store tried to reach the network",
    unexpected.length === 0,
    unexpected.length ? unexpected.join(", ") : `${new Set(refusals).size} un-snapshotted host(s) refused, as expected`,
  );
} finally {
  child.kill();
  await new Promise((res) => child.once("exit", res));
  try {
    rmSync(DB_DIR, { recursive: true, force: true });
  } catch {
    /* a leftover temp file is not a failure */
  }
}

/* ------------------------------------------------------------ §11 step 11 */

step(11, "the unit suite, also with the wire cut");
const vitest = await new Promise((res) => {
  const p = spawn(process.execPath, [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--silent"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import "${GUARD}"`.trim() },
  });
  let out = "";
  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.once("exit", (codeOut) => res({ code: codeOut, out }));
});
const passed = (vitest.out.match(/Tests\s+(\d+) passed/) ?? [])[1];
check("every unit test passes offline", vitest.code === 0, `${passed ?? "?"} tests`);
if (vitest.code !== 0) console.log(vitest.out.slice(-2400));

console.log(
  failures === 0
    ? "\nWifi-failure drill passed. The demo path does not need the internet.\n"
    : `\n${failures} check(s) FAILED with the network cut.\n`,
);
process.exit(failures === 0 ? 0 : 1);
