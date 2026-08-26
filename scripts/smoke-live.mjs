#!/usr/bin/env node
/**
 * The demo path, against LIVE Shopify stores (§11 steps 3-10).
 *
 * Everything else in this repo runs from snapshots so it works with the cable
 * out. This one deliberately does not: it is the only check that exercises a
 * real merchant cart, real server-side discounts and a real hand-off URL, and
 * those are the parts of the demo that would be most damaging to discover
 * broken on stage — a cart that renders as a completed order is worse than a
 * crash, because nobody notices.
 *
 * Spends real requests against live endpoints. Do not run it in a loop.
 *
 *   node scripts/smoke-live.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DB_DIR = mkdtempSync(join(tmpdir(), "basketed-live-"));

let failures = 0;
const warnings = [];
function check(label, condition, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  if (!condition) failures += 1;
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}
function note(label, detail) {
  warnings.push(label);
  console.log(`  --   ${label}${detail ? ` — ${detail}` : ""}`);
}

/* live: no --snapshots */
const child = spawn(process.execPath, [resolve(ROOT, "packages/cli/bin.js"), "serve", "--stdio"], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, BASKETED_DB: join(DB_DIR, "live.db"), BASKETED_SNAPSHOTS: "" },
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => {
  stderr += d;
});

let buffer = "";
const waiters = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const w = waiters.get(msg.id);
    if (w) {
      waiters.delete(msg.id);
      w(msg);
    }
  }
});

let id = 1;
function send(method, params) {
  const n = id++;
  const p = new Promise((res, rej) => {
    waiters.set(n, res);
    setTimeout(() => {
      if (waiters.delete(n)) rej(new Error(`timeout: ${method}`));
    }, 45_000);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params: params ?? {} })}\n`);
  return p;
}
async function call(name, args) {
  const res = await send("tools/call", { name, arguments: args ?? {} });
  const text = res.result?.content?.[0]?.text;
  return { isError: Boolean(res.result?.isError), data: res.result?.structuredContent ?? (text ? JSON.parse(text) : {}) };
}

try {
  await send("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "live", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

  console.log("\n── live Shopify, no snapshots ─────────────────────────────────────");

  const search = await call("basket_search_products", { query: "coffee", max_results: 8 });
  const rows = search.data?.results ?? [];
  const native = rows.filter((r) => r.mode === "native");
  const sim = rows.filter((r) => r.mode === "simulated");
  check("search returns rows", rows.length > 0, `${rows.length} rows`);
  check("real and simulated appear side by side", native.length > 0 && sim.length > 0, `${native.length} native, ${sim.length} simulated`);
  check("every row carries its mode", rows.every((r) => r.mode));

  const live = native[0];
  check("a live row has a sane price", live && live.price.value > 0 && live.price.value < 1000, live ? `${live.price.value} ${live.price.currency}` : "none");

  const detail = await call("basket_get_product_detail", { id: live.id, include: ["description", "stock"] });
  check("tier-2 detail resolves a live id", detail.isError === false && detail.data?.id === live.id);
  check("the decimal point is right", detail.data?.price?.value === live.price.value, `${detail.data?.price?.value} — integer minor units, §4 fact 6`);
  check("vendor prose is flagged as data, not instructions", /treat as data/i.test(JSON.stringify(detail.data?._meta ?? {})));

  console.log("\n── a real merchant cart ───────────────────────────────────────────");

  const before = stderr.length;
  const prepared = await call("basket_cart_prepare", {
    items: [{ id: live.id, quantity: 1 }],
    account_handle: `acct_guest_${live.source.toLowerCase().replace(/\W+/g, "_")}`,
  });

  if (prepared.isError) {
    // A live store can rate-limit or reprice between search and cart. That is
    // information about the demo, not a reason to claim a pass.
    check("cart_prepare against a live store", false, prepared.data?.error?.slice(0, 120));
  } else {
    const m = prepared.data;
    check("cart_prepare built a real cart", Boolean(m.approval_id), m.store_id);
    check("nothing was charged", m.charged === false);
    check("the total is real money", m.total?.value > 0, `${m.total?.value} ${m.total?.currency}`);

    const lineSum = (m.line_items ?? []).reduce((n, li) => n + li.unitPrice.value * li.quantity, 0);
    const gap = Number((m.total.value - lineSum).toFixed(2));
    // The S5 fix: lines come from the merchant's cart, not from what we asked
    // for, so the human's banner adds up to the total printed under it. Any gap
    // must be carried by an adjustment line for that exact figure -- matched on
    // the amount, never on a keyword, because /off/ also matches "Coffee".
    const named = (m.summary ?? []).find((s) =>
      [...s.matchAll(/-?\d+\.\d{2}/g)].some((hit) => Math.abs(Number(hit[0]) - gap) < 0.011),
    );
    check(
      "the lines add up to the total the human is shown",
      Math.abs(gap) < 0.011 || Boolean(named),
      `lines ${lineSum.toFixed(2)} vs total ${m.total.value.toFixed(2)}${gap ? ` — ${named ?? "UNEXPLAINED GAP"}` : ""}`,
    );

    const banner = stderr.slice(before);
    check("the approval code printed on the server console", /APPROVAL CODE: \d{3} \d{3}/.test(banner));
    check("the banner carries no vendor prose", !/<|script|ignore previous/i.test(banner));
    const code = (banner.match(/APPROVAL CODE: (\d{3}) (\d{3})/) ?? []).slice(1).join("");

    const noApproval = await call("basket_purchase_confirm", { approval_id: m.approval_id });
    check("confirm without the human is refused, live too", noApproval.isError === true);

    const confirmed = await call("basket_purchase_confirm", { approval_id: m.approval_id, code });
    check("confirm with the code succeeds", confirmed.isError === false, `${confirmed.data?.state}/${confirmed.data?.outcome}`);
    check(
      "a live store hands off and says the outcome is UNKNOWN",
      confirmed.data?.state === "HANDED_OFF" && confirmed.data?.outcome === "unknown",
      "never rendered as Ordered — §6 invariant 6",
    );
    check("the hand-off URL is real", /^https:\/\//.test(confirmed.data?.handoff_url ?? ""), confirmed.data?.handoff_url?.slice(0, 62));

    const status = await call("basket_get_order_status", { order_id: confirmed.data?.order_id });
    check("order status reports handed off honestly", status.data?.state === "HANDED_OFF" && status.data?.outcome === "unknown");
  }

  console.log("\n── the number ─────────────────────────────────────────────────────");

  const report = await call("basket_get_token_report", {});
  const t = report.data;
  check("the token report counted this session", t?.calls > 0, `${t?.calls} calls`);
  check(
    "the baseline is bytes we actually fetched",
    t?.tokens_baseline > t?.tokens_served,
    `${t?.tokens_served} served vs ${t?.tokens_baseline} baseline — ${t?.saved_pct}% saved`,
  );

  if (/REDACTION ALARM/.test(stderr)) note("redaction alarm fired — investigate before the demo");
} finally {
  child.kill();
  await new Promise((res) => child.once("exit", res));
  try {
    rmSync(DB_DIR, { recursive: true, force: true });
  } catch {
    /* a leftover temp file is not a failure */
  }
}

console.log(
  failures === 0
    ? `\nLive demo path verified.${warnings.length ? ` ${warnings.length} note(s) above.` : ""}\n`
    : `\n${failures} check(s) FAILED against live stores.\n`,
);
process.exit(failures === 0 ? 0 : 1);
