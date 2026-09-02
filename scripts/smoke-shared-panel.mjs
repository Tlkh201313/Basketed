#!/usr/bin/env node
/**
 * Three servers, one panel (S22).
 *
 * Basketed installs into Claude Code, Cursor and Codex, and every one of them
 * launches its own stdio server. Each of those bound its own panel port and
 * opened its own browser window, so opening three editors opened three Chrome
 * windows on three different ports -- and no human could tell which of the
 * three was the one to keep. None of them was: all three read the same
 * database as the same principal, so an approval raised in the third shows up
 * in the first one's tab either way.
 *
 * `claimPanel` already refused to overwrite a live record. The bug was that
 * nobody read the refusal. This starts three real servers and asserts what a
 * person would actually see:
 *
 *   1. the second and third say they are using the first one's panel,
 *   2. the handoff record still names the FIRST server,
 *   3. an approval raised on the third prints a link to the first's panel,
 *      and hands the agent an `approve_url` on that origin too, and
 *   4. that link carries no token -- this process does not have the other
 *      panel's, and deliberately cannot get it.
 *
 * Runs against the simulated stores, so it works with the cable out.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(join(tmpdir(), "basketed-shared-"));

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

/* --- one server, with just enough JSON-RPC to prepare a cart ------------- */

function start(name, port) {
  const child = spawn(
    process.execPath,
    [resolve(ROOT, "packages/cli/bin.js"), "serve", "--stdio", "--snapshots", "--simulated"],
    {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // One database for all three, which is the real situation: three
        // editors, one machine, one user.
        BASKETED_DB: join(WORK, "shared.db"),
        // One handoff record for all three, and NOT the developer's own.
        BASKETED_STATE_DIR: WORK,
        BASKETED_NO_OPEN: "1",
        BASKETED_PANEL_PORT: String(port),
      },
    },
  );

  const server = { name, port, child, stderr: "", stdout: "", waiters: new Map(), nextId: 1 };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (server.stderr += d));

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    server.stdout += chunk;
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
        continue;
      }
      const w = server.waiters.get(msg.id);
      if (w) {
        server.waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  return server;
}

function rpc(server, method, params) {
  const id = server.nextId++;
  const p = new Promise((res, rej) => {
    server.waiters.set(id, res);
    setTimeout(() => rej(new Error(`${server.name}: ${method} timed out`)), 20_000);
  });
  const envelope = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...(params ?? {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "basketed-shared-panel", version: "0.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  server.child.stdin.write(JSON.stringify(envelope) + "\n");
  return p;
}

async function call(server, name, args) {
  const res = await rpc(server, "tools/call", { name, arguments: args ?? {} });
  const body = res.result?.structuredContent ?? JSON.parse(res.result?.content?.[0]?.text ?? "{}");
  return { isError: Boolean(res.result?.isError), data: body };
}

const waitFor = (server, needle, ms = 25_000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (server.stderr.includes(needle)) {
        clearInterval(tick);
        res();
      } else if (Date.now() - t0 > ms) {
        clearInterval(tick);
        rej(new Error(`${server.name} never printed ${JSON.stringify(needle)}:\n${server.stderr}`));
      }
    }, 100);
  });

/* --- the run ------------------------------------------------------------- */

const servers = [];
try {
  console.log("\n-- the first server opens the panel ---------------------------------");
  const first = start("first", 8811);
  servers.push(first);
  await waitFor(first, "[basketed] panel");
  const firstLink = /\[basketed\] panel\s+(\S+)/.exec(first.stderr)?.[1] ?? "";
  const firstUrl = new URL(firstLink);
  const FIRST_ORIGIN = firstUrl.origin;
  const FIRST_TOKEN = firstUrl.searchParams.get("t") ?? "";
  check("it printed its own panel URL", Boolean(FIRST_TOKEN), firstLink);
  check("it did not defer to anybody", !first.stderr.includes("already open at"));

  console.log("\n-- the second and third use it instead of opening their own ---------");
  const second = start("second", 8812);
  const third = start("third", 8813);
  servers.push(second, third);
  await waitFor(second, "already open at");
  await waitFor(third, "already open at");
  for (const s of [second, third]) {
    check(
      `the ${s.name} points at the first panel`,
      s.stderr.includes(`already open at ${FIRST_ORIGIN}`),
      FIRST_ORIGIN,
    );
    check(`the ${s.name} says why`, s.stderr.includes("same database, same approvals"));
  }

  const record = JSON.parse(readFileSync(join(WORK, "panel.json"), "utf8"));
  check("the handoff record still names the first server", record.pid === first.child.pid, JSON.stringify(record));
  check("...on the first server's origin", record.origin === FIRST_ORIGIN, record.origin);

  console.log("\n-- an approval raised on the third lands in the first's panel --------");
  const search = await call(third, "basket_search_products", {
    query: "coffee",
    stores: ["sim:tesco"],
    max_results: 1,
  });
  const product = search.data?.results?.[0];
  check("the third server can still search", Boolean(product), JSON.stringify(search).slice(0, 160));

  const prepared = await call(third, "basket_cart_prepare", {
    items: [{ id: product.id, quantity: 1 }],
    account_handle: "acct_guest_sim_tesco",
  });
  const approvalId = prepared.data?.approval_id;
  check("it prepared a cart that needs a human", Boolean(approvalId));
  check(
    "the agent's approve_url is the FIRST panel's",
    prepared.data.approve_url === `${FIRST_ORIGIN}/approvals/${approvalId}`,
    prepared.data.approve_url,
  );

  await waitFor(third, "[basketed] approve here");
  const summoned = /\[basketed\] approve here\s+(\S+)/.exec(third.stderr)?.[1] ?? "";
  check("the console link goes to the first panel too", summoned.startsWith(`${FIRST_ORIGIN}/approvals/`), summoned);
  check("and it carries no token at all", !summoned.includes("?t="), summoned);
  check("nor the first panel's token, which this process cannot have", !third.stderr.includes(FIRST_TOKEN));

  console.log("\n-- and the first panel really can approve it ------------------------");
  const list = await fetch(`${FIRST_ORIGIN}/api/approvals`, { headers: { "x-basketed-token": FIRST_TOKEN } });
  const card = (await list.json()).approvals.find((a) => a.id === approvalId);
  check("the first panel lists the third server's approval", Boolean(card));

  const approve = await fetch(`${FIRST_ORIGIN}/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-basketed-token": FIRST_TOKEN, origin: FIRST_ORIGIN },
    body: JSON.stringify({ typed_total: card.total.value.toFixed(2) }),
  });
  check("typing the total there approves it", approve.status === 200, `status ${approve.status}`);

  const confirm = await call(third, "basket_purchase_confirm", { approval_id: approvalId });
  check(
    "and the third server's confirm goes through",
    confirm.isError === false,
    JSON.stringify(confirm.data).slice(0, 160),
  );

  console.log("\n-- each server still serves a panel of its own ----------------------");
  // Deliberate: binding costs nothing, and it means the first editor closing
  // leaves the other two with a working panel rather than a dead link.
  const ownLink = /\[basketed\] panel\s+(\S+)/.exec(second.stderr)?.[1] ?? "";
  const ownUrl = new URL(ownLink);
  check("the second bound a port of its own", ownUrl.origin !== FIRST_ORIGIN, ownUrl.origin);
  const own = await fetch(`${ownUrl.origin}/?t=${ownUrl.searchParams.get("t")}`);
  check("and that panel answers", own.status === 200, `status ${own.status}`);
} catch (err) {
  check("the run completed", false, String(err?.message ?? err));
} finally {
  for (const s of servers) s.child.kill();
  await new Promise((r) => setTimeout(r, 400));
  rmSync(WORK, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\nThree servers, one panel. Opening three editors opens one tab."
    : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
