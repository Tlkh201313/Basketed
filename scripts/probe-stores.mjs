#!/usr/bin/env node
/**
 * Day-0 item 2 — two-step Shopify UCP store probe.
 *
 * Step 1: GET /.well-known/ucp for the canonical endpoint.
 * Step 2: if that 404s, STILL POST /api/ucp/mcp with tools/list before writing
 *         the store off. A missing discovery document is not proof of opt-out —
 *         two probes of gymshark.com disagreed on exactly this, and treating a
 *         404 as a "no" would shrink the pinned list from eight stores to one.
 *
 * Writes fixtures/stores.pinned.json. Never hammers: small concurrency, one pass.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Basketed/0.1 (+https://github.com/Tlkh201313/basketed) universal-shopping-mcp";
const TIMEOUT_MS = 12_000;
const CONCURRENCY = 4;

const CANDIDATES = [
  "deathwishcoffee.com",
  "chubbiesshorts.com",
  "tonyschocolonely.com",
  "gymshark.com",
  "allbirds.com",
  "brooklinen.com",
  "ruggable.com",
  "mejuri.com",
  "bombas.com",
  "drsquatch.com",
  "vuoriclothing.com",
  "represent.com",
  "kirrinfinch.com",
  "hiutdenim.co.uk",
  "huel.com",
  "shop.tesla.com",
  "shop.app",
  "meundies.com",
];

async function fetchWithTimeout(url, init = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
}

async function discover(domain) {
  try {
    const res = await fetchWithTimeout(`https://${domain}/.well-known/ucp`, {
      headers: { accept: "application/json", "user-agent": UA },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json();
    // Prefer the canonical endpoint over assuming the path (§4 fact 4).
    const endpoint = body?.services?.["dev.ucp.shopping"]?.[0]?.endpoint ?? null;
    return { ok: true, status: res.status, endpoint, body };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.name ?? err) };
  }
}

async function toolsList(endpoint) {
  try {
    const res = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": UA,
        "Mcp-Method": "tools/list",
        "Mcp-Name": "basketed",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, snippet: text.slice(0, 160) };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // Some endpoints answer as SSE; pull the first data: line.
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      json = line ? JSON.parse(line.slice(5).trim()) : null;
    }
    const tools = json?.result?.tools?.map((t) => t.name) ?? null;
    if (!tools) return { ok: false, status: res.status, snippet: text.slice(0, 160) };
    return { ok: true, status: res.status, tools };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.name ?? err) };
  }
}

async function probe(domain) {
  const disc = await discover(domain);
  const endpoint = disc.endpoint ?? `https://${domain}/api/ucp/mcp`;
  const list = await toolsList(endpoint);

  return {
    domain,
    discovery: disc.ok ? "ok" : `fail:${disc.status || disc.error}`,
    endpoint,
    live: list.ok,
    tools: list.ok ? list.tools : null,
    toolCount: list.ok ? list.tools.length : 0,
    failure: list.ok ? null : `${list.status || list.error}${list.snippet ? ` ${list.snippet}` : ""}`,
    // The headline: discovery said no, the endpoint said yes.
    discoveryMisleading: !disc.ok && list.ok,
  };
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const results = await pool(CANDIDATES, CONCURRENCY, probe);

const live = results.filter((r) => r.live);
const misleading = results.filter((r) => r.discoveryMisleading);

for (const r of results) {
  const mark = r.live ? "LIVE " : "dead ";
  const note = r.discoveryMisleading ? "  <-- discovery 404 but endpoint LIVE" : "";
  console.log(
    `${mark} ${r.domain.padEnd(24)} discovery=${r.discovery.padEnd(12)} tools=${String(r.toolCount).padStart(2)}${note}`,
  );
  if (!r.live && r.failure) console.log(`       ${r.failure}`);
}

console.log(`\n${live.length}/${results.length} live.`);
if (misleading.length) {
  console.log(
    `${misleading.length} would have been WRONGLY EXCLUDED by a discovery-only probe: ${misleading
      .map((r) => r.domain)
      .join(", ")}`,
  );
}

const pinned = {
  probed_at: new Date().toISOString(),
  api_version: "2026-04-08",
  note: "Two-step probe. A missing /.well-known/ucp is not proof of opt-out; tools/list decides.",
  stores: live.map((r) => ({
    id: `shp:${r.domain.replace(/\./g, "-")}`,
    domain: r.domain,
    endpoint: r.endpoint,
    mode: "native",
    tools: r.tools,
    discovery: r.discovery,
  })),
};

await mkdir(resolve(ROOT, "fixtures"), { recursive: true });
await writeFile(resolve(ROOT, "fixtures/stores.pinned.json"), JSON.stringify(pinned, null, 2) + "\n");
console.log(`\nWrote fixtures/stores.pinned.json (${pinned.stores.length} stores).`);
