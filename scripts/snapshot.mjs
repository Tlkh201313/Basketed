#!/usr/bin/env node
/**
 * Day-0 item 3 — capture real UCP responses to fixtures/snapshots/.
 *
 * Insurance against venue wifi. `BASKETED_SNAPSHOTS=1` makes the Shopify
 * adapter replay these instead of hitting the wire (§11 wifi-failure drill).
 *
 * Also the source of truth for the S2 response mapping: whatever shape is
 * captured here is the shape the adapter normalises.
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = resolve(ROOT, "fixtures/snapshots");
const UA = "Basketed/0.1 (+https://github.com/Tlkh201313/basketed) universal-shopping-mcp";

const PROFILE =
  process.env.BASKETED_UCP_PROFILE ??
  "https://cdn.statically.io/gist/Tlkh201313/1d42ef351a9075c75901f539bae847bc/raw/ucp-profile.json";

const meta = { "ucp-agent": { profile: PROFILE } };

async function call(endpoint, name, args) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": UA,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: { meta, ...args } },
    }),
  });
  const text = await res.text();
  const json = JSON.parse(text);
  if (json.error) throw new Error(`${name}: ${JSON.stringify(json.error).slice(0, 300)}`);
  const block = json.result?.content?.[0];
  const payload = block?.text ? JSON.parse(block.text) : json.result?.structuredContent;
  if (json.result?.isError) throw new Error(`${name}: ${block?.text?.slice(0, 200)}`);
  return { rawBytes: text.length, payload };
}

const pinned = JSON.parse(await readFile(resolve(ROOT, "fixtures/stores.pinned.json"), "utf8"));
// Three demo stores is enough insurance; more just burns their rate limits.
const targets = pinned.stores.slice(0, 3);

await mkdir(SNAP, { recursive: true });
const index = [];

for (const store of targets) {
  const key = store.domain.replace(/\./g, "-");
  try {
    const search = await call(store.endpoint, "search_catalog", {
      catalog: { query: "coffee", context: { currency: "USD", address_country: "US" } },
    });
    await writeFile(
      resolve(SNAP, `${key}.search.json`),
      JSON.stringify({ store: store.domain, capturedAt: new Date().toISOString(), ...search }, null, 2) + "\n",
    );

    const products = search.payload?.products ?? [];
    const variantId = products[0]?.variants?.[0]?.id ?? null;
    let cartBytes = null;
    let handoff = null;

    if (variantId) {
      const cart = await call(store.endpoint, "create_cart", {
        cart: {
          line_items: [{ item: { id: variantId }, quantity: 1 }],
          context: { address_country: "US", currency: "USD" },
        },
      });
      await writeFile(
        resolve(SNAP, `${key}.cart.json`),
        JSON.stringify({ store: store.domain, variantId, ...cart }, null, 2) + "\n",
      );
      cartBytes = cart.rawBytes;
      // §4 fact 5 — find the hand-off URL empirically rather than trusting a field name.
      const blob = JSON.stringify(cart.payload);
      handoff =
        cart.payload?.continue_url ??
        cart.payload?.cart?.continue_url ??
        (blob.match(/"(https:\/\/[^"]*checkouts?[^"]*)"/)?.[1] ?? null);
    }

    index.push({
      store: store.domain,
      products: products.length,
      searchRawBytes: search.rawBytes,
      cartRawBytes: cartBytes,
      handoffUrlFound: Boolean(handoff),
      handoffSample: handoff ? handoff.slice(0, 90) : null,
    });
    console.log(
      `ok   ${store.domain.padEnd(24)} products=${String(products.length).padStart(2)} search=${search.rawBytes}B cart=${cartBytes ?? "-"}B handoff=${handoff ? "yes" : "NO"}`,
    );
  } catch (err) {
    console.log(`FAIL ${store.domain.padEnd(24)} ${String(err.message).slice(0, 160)}`);
    index.push({ store: store.domain, error: String(err.message).slice(0, 300) });
  }
}

await writeFile(resolve(SNAP, "index.json"), JSON.stringify({ profile: PROFILE, captured: index }, null, 2) + "\n");
console.log(`\nWrote ${index.length} snapshot sets to fixtures/snapshots/.`);
