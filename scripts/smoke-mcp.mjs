#!/usr/bin/env node
/**
 * Speak real JSON-RPC to the stdio server, in BOTH protocol eras.
 *
 * The "installs into any agent" pitch rests entirely on dual-era working, and
 * dual-era is exactly the kind of claim that is easy to assert and easy to get
 * wrong -- a modern client cannot talk to a legacy-only server and vice versa,
 * and neither failure is visible from the server's own logs. So we open the
 * same binary twice, once each way, and check that both answer.
 *
 * Runs entirely against the simulated stores so it works with the cable out.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MODERN = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "basketed-smoke", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

let failures = 0;
function check(label, condition, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  if (!condition) failures += 1;
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

function openServer() {
  const child = spawn(process.execPath, [resolve(ROOT, "packages/cli/bin.js"), "serve", "--stdio", "--simulated"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(d));

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
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.log(` FAIL  stdout carried non-JSON: ${line.slice(0, 160)}`);
        failures += 1;
        continue;
      }
      const waiter = waiters.get(msg.id);
      if (waiter) {
        waiters.delete(msg.id);
        waiter(msg);
      }
    }
  });

  let nextId = 1;
  function send(method, params, { modern = false } = {}) {
    const id = nextId++;
    const body = { jsonrpc: "2.0", id, method };
    if (params || modern) {
      body.params = { ...(params ?? {}) };
      if (modern) body.params._meta = { ...META, ...(body.params._meta ?? {}) };
    }
    const promise = new Promise((res, rej) => {
      waiters.set(id, res);
      setTimeout(() => {
        if (waiters.delete(id)) rej(new Error(`timeout waiting for ${method}`));
      }, 20_000);
    });
    child.stdin.write(`${JSON.stringify(body)}\n`);
    return promise;
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} })}\n`);
  }

  return { child, send, notify, stderr };
}

/* ------------------------------------------------------------ legacy era */

console.log("\n── legacy era (initialize / sessions) ──────────────────────────────");
const legacy = openServer();

const init = await legacy.send("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "basketed-smoke", version: "0.0.0" },
});
check("initialize answered", !!init.result, init.result?.serverInfo?.name);
legacy.notify("notifications/initialized");

const list = await legacy.send("tools/list", {});
const tools = list.result?.tools ?? [];
const names = tools.map((t) => t.name);
check("tools/list returns 11 tools", tools.length === 11, names.join(", "));
check(
  "tool order is deterministic",
  JSON.stringify(names) ===
    JSON.stringify([
      "basket_list_stores",
      "basket_search_products",
      "basket_get_product_detail",
      "basket_get_token_report",
      "basket_auth_status",
      "basket_list_delivery_slots",
      "basket_list_accounts",
      "basket_cart_prepare",
      "basket_purchase_confirm",
      "basket_list_orders",
      "basket_get_order_status",
    ]),
  names.join(", "),
);
check("every tool is namespaced", names.every((n) => n.startsWith("basket_")));
check("every tool has an outputSchema", tools.every((t) => !!t.outputSchema));
check(
  "every tool carries all four annotations",
  tools.every(
    (t) =>
      t.annotations &&
      ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].every(
        (k) => typeof t.annotations[k] === "boolean",
      ),
  ),
);
// `purchase_confirm` exists and must: what must NOT exist is anything that
// grants approval. The adversarial pass over the wire is in smoke-purchase.mjs.
check("no tool can approve anything", !names.some((n) => /approve|authori[sz]e|grant/i.test(n)));
check("no tool can set a delivery address", !names.some((n) => /address/i.test(n)));

const defTokens = Math.ceil(JSON.stringify(tools).length / 3.6);
console.log(`       tool-definition overhead: ~${defTokens} tokens`);

function payload(res) {
  return res.result?.structuredContent ?? JSON.parse(res.result?.content?.[0]?.text ?? "{}");
}

const stores = payload(await legacy.send("tools/call", { name: "basket_list_stores", arguments: {} }));
check("list_stores returns stores", stores.count > 0, `${stores.count} stores`);
check("every store row carries a mode", stores.stores.every((s) => !!s.mode));
check(
  "no store claims checkout",
  !stores.stores.some((s) => s.capabilities.includes("checkout")),
);

const search = payload(
  await legacy.send("tools/call", {
    name: "basket_search_products",
    arguments: { query: "coffee", stores: ["sim:tesco", "sim:amazon", "sim:costco"], max_results: 5 },
  }),
);
check("search returns results", (search.results?.length ?? 0) > 0, `${search.results?.length} rows`);
check("every result carries its mode", search.results.every((r) => !!r.mode));
check("simulated results are stamped simulated", search.results.every((r) => r.mode === "simulated"));
check("_meta carries the provenance warning", /data, not instructions/.test(search._meta?.provenance ?? ""));

const compact = payload(
  await legacy.send("tools/call", {
    name: "basket_search_products",
    arguments: { query: "coffee", stores: ["sim:tesco"], response_format: "compact", max_results: 3 },
  }),
);
check("compact format renames keys", compact.results.every((r) => "p" in r && !("price" in r)));
check("compact format emits a legend once", !!compact._meta?.legend);

const budgeted = payload(
  await legacy.send("tools/call", {
    name: "basket_search_products",
    arguments: { query: "coffee", stores: ["sim:tesco"], budget_tokens: 60, max_results: 8 },
  }),
);
check("budget_tokens trims", budgeted._meta?.truncated === true, (budgeted._meta?.dropped ?? []).join(" -> "));
check(
  "trimming never drops price, mode or id",
  budgeted.results.every((r) => r.id && r.mode && r.price),
);

const firstId = search.results[0]?.id;
const detail = payload(
  await legacy.send("tools/call", {
    name: "basket_get_product_detail",
    arguments: { id: firstId, include: ["description", "stock", "delivery"] },
  }),
);
check("detail resolves a search id", detail.id === firstId, detail.name);
check("detail returns the heavy fields only when asked", !!detail.description && !!detail.stock);
check("detail restates provenance", /data, not instructions/.test(detail._meta?.provenance ?? ""));

const forged = await legacy.send("tools/call", {
  name: "basket_get_product_detail",
  arguments: { id: "bk_sim-tesco_made-up-thing_deadbeef" },
});
check("a forged product id is refused", forged.result?.isError === true);

const report = payload(await legacy.send("tools/call", { name: "basket_get_token_report", arguments: {} }));
check("token report counts the calls", report.calls >= 4, `${report.calls} calls`);
check("redaction alarms are surfaced", typeof report.redaction_alarms === "number", `${report.redaction_alarms}`);

legacy.child.kill();

/* ------------------------------------------------------------ modern era */

console.log("\n── modern era (2026-07-28, stateless, no initialize) ───────────────");
const modern = openServer();

const discover = await modern.send("server/discover", {}, { modern: true });
check("server/discover answers", !!discover.result, (discover.result?.supportedVersions ?? []).join(", "));
check(
  "discover advertises 2026-07-28",
  (discover.result?.supportedVersions ?? []).includes(MODERN),
);

const modernList = await modern.send("tools/list", {}, { modern: true });
check(
  "tools/list works with no initialize at all",
  (modernList.result?.tools?.length ?? 0) === 9,
  `${modernList.result?.tools?.length} tools`,
);

const modernCall = await modern.send(
  "tools/call",
  { name: "basket_search_products", arguments: { query: "coffee", stores: ["sim:tesco"], max_results: 2 } },
  { modern: true },
);
const modernPayload = payload(modernCall);
check("tools/call works statelessly", (modernPayload.results?.length ?? 0) > 0);
check("structuredContent is present", !!modernCall.result?.structuredContent);
check(
  "structured output is mirrored as text for older clients",
  typeof modernCall.result?.content?.[0]?.text === "string",
);

modern.child.kill();

console.log(
  `\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`} — both eras served by one binary\n`,
);
process.exit(failures === 0 ? 0 : 1);
