#!/usr/bin/env node
/** The demo moment: real Shopify results and simulated results, side by side, each labelled. */
import { StoreRegistry, loadPinnedShopifyStores, SimulatedAdapter } from "../packages/adapters/dist/index.js";
import { searchAll } from "../packages/commerce/dist/index.js";

const ctx = { http: fetch, log: (m) => console.log(`   · ${m}`), snapshots: process.env.BASKETED_SNAPSHOTS === "1" };

const registry = new StoreRegistry();
for (const a of (await loadPinnedShopifyStores()).slice(0, 3)) registry.register(a);
for (const a of await SimulatedAdapter.loadAll()) registry.register(a);

console.log(`registry: ${registry.ids().length} stores`);
for (const row of registry.list()) {
  console.log(`  ${row.mode.padEnd(10)} ${row.id.padEnd(28)} ${row.country} ${row.currency}  [${row.capabilities.join(",")}]`);
}

const { result, diagnostics } = await searchAll(registry, { query: "coffee", maxResults: 10 }, ctx, { maxResults: 10 });

console.log(`\nqueried ${diagnostics.queried.length} stores, ${diagnostics.failed.length} failed`);
for (const f of diagnostics.failed) console.log(`  failed: ${f.store} — ${f.reason}`);

console.log(`\n${"MODE".padEnd(11)}${"PRICE".padStart(10)}  ${"RATING".padEnd(8)} NAME`);
for (const p of result.results) {
  const stamp = p.mode === "simulated" ? "SIMULATED" : p.mode;
  const rating = p.rating ? `${p.rating.score}/5` : "—";
  console.log(`${stamp.padEnd(11)}${(p.price.value.toFixed(2) + " " + p.price.currency).padStart(10)}  ${rating.padEnd(8)} ${p.name.slice(0, 52)}`);
}
console.log(`\ntokens ${result._meta.tokens.estimated} vs baseline ${result._meta.tokens.baseline} → ${result._meta.tokens.saved_pct}% saved`);
console.log(`provenance: ${result._meta.provenance}`);
