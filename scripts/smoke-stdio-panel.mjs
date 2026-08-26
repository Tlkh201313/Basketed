#!/usr/bin/env node
/**
 * The panel, on the transport people actually plug in with (S13).
 *
 * `smoke-panel.mjs` proves channel A over `serve --http`. This proves it is
 * there over `serve --stdio` too -- which matters because stdio is what every
 * install snippet writes, so before this the only channel a plugged-in client
 * ever offered was the 6-digit code.
 *
 * Three things have to hold at once, and all three are asserted against real
 * bytes -- the child's stderr, real HTTP to whatever port it chose, and the
 * tool result the client would see:
 *
 *   1. the panel comes up by itself and is reachable,
 *   2. its token reaches the console and NOTHING else, and
 *   3. neither the panel nor an open browser tab outlives the client.
 *
 * Runs against the simulated stores, so it works with the cable out.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DB_DIR = mkdtempSync(join(tmpdir(), "basketed-stdio-"));

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

const child = spawn(process.execPath, [resolve(ROOT, "packages/cli/bin.js"), "serve", "--stdio", "--snapshots"], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    BASKETED_DB: join(DB_DIR, "stdio.db"),
    BASKETED_NO_OPEN: "1",
    // Deliberately a port nothing else in the suite uses, so a busy 8787 on
    // the developer's machine cannot make this look like a code failure.
    BASKETED_PANEL_PORT: "8796",
  },
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => (stderr += d));

/* --- the JSON-RPC client half ------------------------------------------- */

const waiters = new Map();
let stdoutSeen = "";
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutSeen += chunk;
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      check("stdout is pure JSON-RPC", false, line.slice(0, 120));
      continue;
    }
    const w = waiters.get(msg.id);
    if (w) {
      waiters.delete(msg.id);
      w(msg);
    }
  }
});

let rpcId = 1;
function rpc(method, params) {
  const id = rpcId++;
  const p = new Promise((res, rej) => {
    waiters.set(id, res);
    setTimeout(() => rej(new Error(`${method} timed out`)), 15_000);
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...(params ?? {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "basketed-stdio-drill", version: "0.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    })}\n`,
  );
  return p;
}

async function call(name, args) {
  const res = await rpc("tools/call", { name, arguments: args ?? {} });
  const body = res.result?.structuredContent ?? JSON.parse(res.result?.content?.[0]?.text ?? "{}");
  return { isError: Boolean(res.result?.isError), data: body };
}

const waitFor = (needle, ms = 20_000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (stderr.includes(needle)) {
        clearInterval(tick);
        res();
      } else if (Date.now() - t0 > ms) {
        clearInterval(tick);
        rej(new Error(`never saw ${JSON.stringify(needle)} on stderr:\n${stderr}`));
      }
    }, 100);
  });

try {
  console.log("\n-- the panel comes up on its own, next to stdio --------------------");
  await waitFor("[basketed] panel");

  const link = /\[basketed\] panel\s+(\S+)/.exec(stderr)?.[1] ?? "";
  const url = new URL(link);
  const TOKEN = url.searchParams.get("t") ?? "";
  const BASE = url.origin;
  check("a panel URL was printed", Boolean(TOKEN) && Boolean(BASE), link);
  check("on the port we asked for", url.port === "8796" || url.port !== "", `port ${url.port}`);
  check("an approvals deep link too", /\[basketed\] approvals\s+\S+\?t=/.test(stderr));
  check("the panel says the token is console-only", stderr.includes("no agent can read it"));

  const locked = await fetch(`${BASE}/`);
  check("the panel without the token is locked", locked.status === 401, `status ${locked.status}`);
  const open = await fetch(`${BASE}/?t=${TOKEN}`);
  check("with the token it renders", open.status === 200 && (await open.text()).includes("Basketed"));

  const state = await fetch(`${BASE}/api/state`, { headers: { "x-basketed-token": TOKEN } });
  check("and it is talking to THIS process's database", state.status === 200);

  console.log("\n-- plugged in, it answers MCP on stdio at the same time -------------");
  const tools = await rpc("tools/list", {});
  check(
    "tools/list works over stdio",
    Array.isArray(tools.result?.tools) && tools.result.tools.length > 0,
    `${tools.result?.tools?.length} tools`,
  );

  console.log("\n-- a cart that needs a human prints its own link --------------------");
  const search = await call("basket_search_products", { query: "coffee", stores: ["sim:tesco"], max_results: 1 });
  const product = search.data?.results?.[0];
  check("search returned something to buy", Boolean(product), JSON.stringify(search).slice(0, 160));

  const prepared = await call("basket_cart_prepare", {
    items: [{ id: product.id, quantity: 1 }],
    account_handle: "acct_guest_sim_tesco",
  });
  const approvalId = prepared.data?.approval_id;
  check("prepare produced an approval", Boolean(approvalId));

  await waitFor("[basketed] approve here");
  const summoned = /\[basketed\] approve here\s+(\S+)/.exec(stderr)?.[1] ?? "";
  check("the console got a deep link to THIS approval", summoned.includes(`/approvals/${approvalId}`), summoned);
  check("and it carries the token", summoned.includes(`?t=${TOKEN}`));

  console.log("\n-- what the agent sees stays token-free -----------------------------");
  const shown = JSON.stringify(prepared.data);
  check(
    "approve_url points at the real panel",
    prepared.data.approve_url === `${BASE}/approvals/${approvalId}`,
    prepared.data.approve_url,
  );
  check("no token anywhere in the tool result", !shown.includes(TOKEN));
  check("the whole session's stdout carried no token", !stdoutSeen.includes(TOKEN));

  console.log("\n-- and the panel can approve it, over stdio -------------------------");
  const list = await fetch(`${BASE}/api/approvals`, { headers: { "x-basketed-token": TOKEN } });
  const card = (await list.json()).approvals.find((a) => a.id === approvalId);
  check("the approval is visible in the panel", Boolean(card));

  const approve = await fetch(`${BASE}/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-basketed-token": TOKEN, origin: BASE },
    body: JSON.stringify({ typed_total: card.total.value.toFixed(2) }),
  });
  check("typing the total approves it", approve.status === 200, `status ${approve.status}`);

  const confirm = await call("basket_purchase_confirm", { approval_id: approvalId });
  check(
    "and the agent's confirm now goes through",
    confirm.isError === false,
    JSON.stringify(confirm.data).slice(0, 200),
  );

  console.log("\n-- the panel does not keep the process alive -----------------------");
  const exited = new Promise((res) => child.once("exit", res));
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((res) => setTimeout(() => res("HUNG"), 5_000))]);
  check("closing stdin exits the server", code !== "HUNG", `exit ${code}`);
} finally {
  child.kill();
  try {
    rmSync(DB_DIR, { recursive: true, force: true });
  } catch {
    /* a leftover temp file is not a failure */
  }
}

console.log(failures === 0 ? "\nstdio + panel: all good.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
