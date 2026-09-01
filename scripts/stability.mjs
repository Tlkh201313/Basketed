#!/usr/bin/env node
/**
 * How often does this actually work?
 *
 * Every other script in here answers "does the code do the right thing once".
 * That is not the question a demo asks. A demo asks whether the twenty-first
 * cold start also comes up, whether a port that was fine a minute ago is still
 * fine, whether an id minted by one process still verifies in the next. Those
 * are failures that never show up in a suite that starts the server once.
 *
 * So this starts it again and again, from scratch, and reports a rate.
 *
 *   20 x  serve --stdio, each a fresh process with a fresh database:
 *         initialize, list the tools, search sim:tesco, read a detail,
 *         prepare a cart, then exit cleanly.
 *    5 x  serve --http: come up, answer /healthz, answer /mcp, exit cleanly.
 *
 * Each run gets its own database directory and its own panel port, so a run
 * can only fail for its own reasons. A run counts as passed only if every step
 * passed AND the child exited on its own -- a server that has to be killed is
 * not a server that worked.
 *
 * Exits 1 below 95%. The number in the README is whatever this last printed.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BIN = resolve(ROOT, "packages/cli/bin.js");
const WORK = mkdtempSync(join(tmpdir(), "basketed-stability-"));

const STDIO_RUNS = Number(process.env["BASKETED_STABILITY_STDIO"] ?? 20);
const HTTP_RUNS = Number(process.env["BASKETED_STABILITY_HTTP"] ?? 5);
const THRESHOLD = 95;

/** Ports well away from 8787/8788 and from every smoke script's choices. */
const PANEL_PORT_BASE = 8830;
const HTTP_PORT_BASE = 8870;

const failures = [];

function line(label, ok, detail = "") {
  process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function baseEnv(runId) {
  return {
    ...process.env,
    BASKETED_DB: join(WORK, `${runId}.db`),
    BASKETED_STATE_DIR: join(WORK, `${runId}-state`),
    BASKETED_NO_OPEN: "1",
    // No Chromium: this measures whether the server starts, not whether a
    // retailer's anti-bot layer is in a good mood.
    BASKETED_NO_BROWSER: "1",
  };
}

/** Waits for a child to exit, killing it if it overstays. Resolves to the code. */
function waitForExit(child, ms) {
  return new Promise((res) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      res({ code: null, killed: true });
    }, ms);
    child.once("exit", (code) => {
      clearTimeout(timer);
      res({ code, killed: false });
    });
  });
}

/* ------------------------------------------------------------------ stdio */

/**
 * One cold start over stdio, all the way to a prepared cart.
 *
 * The cart matters more than the search: preparing one exercises the id HMAC,
 * the per-store id cache, the guardrails and the approval banner, and every
 * one of those reads or writes state that a previous run may have left behind.
 */
async function stdioRun(n) {
  const child = spawn(process.execPath, [BIN, "serve", "--stdio", "--snapshots", "--simulated"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...baseEnv(`stdio-${n}`), BASKETED_PANEL_PORT: String(PANEL_PORT_BASE + n) },
  });

  const waiters = new Map();
  let buf = "";
  let stderr = "";
  let junkOnStdout = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!raw) continue;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        // stdout IS the protocol here. A stray console.log corrupts the stream
        // and the client reports a parse error with no hint where it came from.
        junkOnStdout += `${raw.slice(0, 120)}\n`;
        continue;
      }
      const w = waiters.get(msg.id);
      if (w) {
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });

  let id = 1;
  const rpc = (method, params) => {
    const rid = id++;
    const p = new Promise((res, rej) => {
      waiters.set(rid, res);
      setTimeout(() => rej(new Error(`${method} timed out`)), 20_000);
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: rid,
        method,
        params: {
          ...(params ?? {}),
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "basketed-stability", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      })}\n`,
    );
    return p;
  };

  const call = async (name, args) => {
    const res = await rpc("tools/call", { name, arguments: args ?? {} });
    const data = res.result?.structuredContent ?? JSON.parse(res.result?.content?.[0]?.text ?? "{}");
    return { isError: Boolean(res.result?.isError), data };
  };

  const problems = [];
  try {
    const tools = await rpc("tools/list", {});
    if (!(tools.result?.tools ?? []).length) problems.push("tools/list served nothing");

    const found = await call("basket_search_products", { query: "coffee", stores: ["sim:tesco"], max_results: 3 });
    const products = found.data?.results ?? [];
    if (!products.length) problems.push("search returned no products");

    if (products.length) {
      const detail = await call("basket_get_product_detail", { id: products[0].id });
      if (detail.isError) problems.push(`detail refused: ${JSON.stringify(detail.data).slice(0, 120)}`);

      const cart = await call("basket_cart_prepare", {
        items: [{ id: products[0].id, quantity: 1 }],
        account_handle: "acct_guest_sim_tesco",
      });
      if (cart.isError || !cart.data?.approval_id) {
        problems.push(`cart_prepare refused: ${JSON.stringify(cart.data).slice(0, 160)}`);
      }
    }
  } catch (err) {
    problems.push(err.message);
  }

  if (junkOnStdout) problems.push(`non-JSON on stdout: ${junkOnStdout.split("\n")[0]}`);

  child.stdin.end();
  const exit = await waitForExit(child, 10_000);
  if (exit.killed) problems.push("did not exit when stdin closed");
  else if (exit.code !== 0 && exit.code !== null) problems.push(`exit code ${exit.code}`);

  if (problems.length && stderr.trim()) problems.push(`stderr: ${stderr.trim().split("\n").slice(-2).join(" / ")}`);
  return problems;
}

/* ------------------------------------------------------------------- http */

/** One cold start over Streamable HTTP: healthz, then a real tools/list. */
async function httpRun(n) {
  const port = HTTP_PORT_BASE + n;
  const child = spawn(
    process.execPath,
    [BIN, "serve", "--http", "--port", String(port), "--snapshots", "--simulated"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: baseEnv(`http-${n}`) },
  );

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (stderr += d));

  const problems = [];
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/healthz`);
      if (res.ok) {
        const body = await res.json();
        if (body?.name !== "basketed") problems.push(`/healthz is not ours: ${JSON.stringify(body).slice(0, 80)}`);
        up = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) problems.push("never answered /healthz");

  if (up) {
    try {
      const res = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          // 2026-07-28 requires the method in a header as well as the body, so
          // a proxy can route without parsing JSON-RPC.
          "Mcp-Method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "basketed-stability", version: "0.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      const text = await res.text();
      // Either era may answer as JSON or as one SSE frame; both carry the array.
      if (!/"tools"\s*:\s*\[/.test(text)) problems.push(`/mcp did not list tools: ${text.slice(0, 120)}`);
    } catch (err) {
      problems.push(`/mcp: ${err.message}`);
    }
  }

  child.kill("SIGTERM");
  const exit = await waitForExit(child, 10_000);
  if (exit.killed) problems.push("did not shut down on SIGTERM");

  if (problems.length && stderr.trim()) problems.push(`stderr: ${stderr.trim().split("\n").slice(-2).join(" / ")}`);
  return problems;
}

/* ------------------------------------------------------------------- main */

console.log("\nBasketed stability — cold starts, one process at a time");
console.log(`  ${STDIO_RUNS} x serve --stdio (search → detail → cart), ${HTTP_RUNS} x serve --http (healthz → tools/list)`);
console.log(`  fresh database and state directory per run, under ${WORK}\n`);

let passed = 0;
let total = 0;

console.log("── stdio ──────────────────────────────────────────────────────────");
for (let n = 0; n < STDIO_RUNS; n++) {
  const problems = await stdioRun(n);
  total += 1;
  if (problems.length === 0) passed += 1;
  else failures.push(`stdio #${n + 1}: ${problems.join("; ")}`);
  line(`stdio run ${n + 1}/${STDIO_RUNS}`, problems.length === 0, problems[0] ?? "");
}

console.log("\n── http ───────────────────────────────────────────────────────────");
for (let n = 0; n < HTTP_RUNS; n++) {
  const problems = await httpRun(n);
  total += 1;
  if (problems.length === 0) passed += 1;
  else failures.push(`http #${n + 1}: ${problems.join("; ")}`);
  line(`http run ${n + 1}/${HTTP_RUNS}`, problems.length === 0, problems[0] ?? "");
}

rmSync(WORK, { recursive: true, force: true });

const pct = total ? (passed / total) * 100 : 0;
const rounded = Math.round(pct * 10) / 10;
console.log(`\n${passed}/${total} (${rounded}%)`);

if (failures.length) {
  console.log("\nWhat went wrong:");
  for (const f of failures) console.log(`  - ${f}`);
}

if (pct < THRESHOLD) {
  console.log(`\nBelow the ${THRESHOLD}% floor. A demo that works four times in five is a demo that fails on stage.`);
  process.exit(1);
}
console.log(`\nAt or above the ${THRESHOLD}% floor.`);
