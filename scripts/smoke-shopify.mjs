#!/usr/bin/env node
/**
 * Live end-to-end proof of the S2 adapter: search -> normalise -> real cart ->
 * hand-off URL. Prints the token saving against the raw upstream payload.
 *
 * `BASKETED_SNAPSHOTS=1 node scripts/smoke-shopify.mjs` runs the same path off
 * the captured fixtures, which is the wifi-failure drill.
 */
import { loadPinnedShopifyStores } from "../packages/adapters/dist/shopify-ucp/load.js";
import { trimResults, buildMeta } from "../packages/core/dist/tokens/estimate.js";
import { StoreRegistry } from "../packages/adapters/dist/registry.js";

const ctx = {
  http: fetch,
  log: (m, meta) => console.log(`   · ${m}${meta ? ` ${JSON.stringify(meta)}` : ""}`),
  snapshots: process.env.BASKETED_SNAPSHOTS === "1",
};

const adapters = await loadPinnedShopifyStores();
console.log(`loaded ${adapters.length} pinned Shopify stores${ctx.snapshots ? " (snapshot mode)" : ""}\n`);

// The registry refuses any adapter that overclaims, so this also proves the
// manifest matches what the class actually implements.
const registry = new StoreRegistry();
for (const a of adapters) registry.register(a);
console.log(`registry accepted all ${registry.ids().length} adapters (no overclaimed tiers)\n`);

const store = adapters.find((a) => a.manifest.domain === "deathwishcoffee.com") ?? adapters[0];
console.log(`--- ${store.manifest.name} (${store.manifest.domain}) ---`);

const products = await store.search({ query: "coffee", maxResults: 8 }, ctx);
console.log(`search returned ${products.length} normalised products`);
console.log(`upstream raw payload: ${store.lastRawBytes.toLocaleString()} bytes\n`);

for (const p of products.slice(0, 3)) {
  console.log(`  ${p.name}`);
  console.log(`    ${p.price.value.toFixed(2)} ${p.price.currency}  mode=${p.mode}  cat=${p.attrs?.cat}`);
  console.log(`    ${p.id}`);
}

const outcome = trimResults(products, { maxResults: 8 });
const meta = buildMeta({
  storesQueried: [store.manifest.domain],
  baselineBytes: store.lastRawBytes,
  outcome,
});
console.log(`\ntokens: ${meta.tokens.estimated} vs baseline ${meta.tokens.baseline} → ${meta.tokens.saved_pct}% saved`);

const first = products[0];
if (!first) {
  console.log("\nno products, cannot build a cart");
  process.exit(1);
}

console.log(`\n--- cart_prepare path (NO charge, no payment details) ---`);
const cart = await store.buildCart([{ id: first.id, quantity: 1 }], ctx);
console.log(`cart id      : ${cart.cartId.slice(0, 60)}`);
for (const li of cart.lineItems) {
  console.log(`line item    : ${li.quantity} x ${li.name} @ ${li.unitPrice.value.toFixed(2)} ${li.unitPrice.currency}`);
}
for (const adj of cart.adjustments) {
  console.log(`adjustment   : ${adj.label} ${adj.amount.value.toFixed(2)} ${adj.amount.currency}`);
}
console.log(`subtotal     : ${cart.subtotal.value.toFixed(2)} ${cart.subtotal.currency}`);
console.log(`TOTAL        : ${cart.total.value.toFixed(2)} ${cart.total.currency}`);
console.log(`hand-off URL : ${cart.handoffUrl ?? "MISSING"}`);

if (!cart.handoffUrl) {
  console.log("\nFAIL: no hand-off URL. purchase_confirm would return nothing usable.");
  process.exit(1);
}
console.log("\nOK: real cart, real totals, real checkout URL, and no money moved.");
