import { describe, expect, it, beforeAll } from "vitest";
import { resolve } from "node:path";
import { StoreRegistry } from "./registry.js";
import { parseProductId } from "./ids.js";
import { loadPinnedShopifyStores } from "./shopify-ucp/load.js";
import { SimulatedAdapter } from "./simulated/adapter.js";
import type { AdapterCtx, StoreAdapter } from "./types.js";

/**
 * The id round-trip, across the registry seam.
 *
 * This exists because of a real bug: the Shopify adapter minted ids against
 * its bare domain while the registry keyed it as `shp:<domain>`, so
 * `parseProductId` -- which re-derives the tag from every store the registry
 * knows -- never matched. Search looked perfect; every tier-2 call against a
 * real store failed with "no such product". The unit tests passed either way,
 * because each one only ever saw a single adapter.
 *
 * Runs entirely from `fixtures/snapshots/`, so it also serves as the offline
 * drill: the same assertions hold with the network cable out.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const ctx: AdapterCtx = { http: fetch, log: () => {}, snapshots: true };

/**
 * Captured at Day-0. Only these three have a search snapshot at all, and
 * tonyschocolonely's capture holds zero products -- that store genuinely
 * returned nothing for the captured query, which the fixture records rather
 * than papers over.
 */
const SNAPSHOTTED_WITH_PRODUCTS = ["shp:deathwishcoffee.com", "shp:chubbiesshorts.com"];
const SNAPSHOTTED_EMPTY = "shp:tonyschocolonely.com";

let registry: StoreRegistry;

beforeAll(async () => {
  registry = new StoreRegistry();
  for (const a of await loadPinnedShopifyStores(ROOT)) registry.register(a);
  for (const a of await SimulatedAdapter.loadAll(ROOT)) registry.register(a);
});

async function idsFrom(adapter: StoreAdapter): Promise<string[]> {
  const products = await adapter.search({ query: "coffee", maxResults: 5 }, ctx);
  return products.map((p) => p.id);
}

describe("product id round-trip through the registry", () => {
  it("resolves a real Shopify id back to the adapter that minted it", async () => {
    for (const id of SNAPSHOTTED_WITH_PRODUCTS) {
      const adapter = registry.get(id)!;
      expect(adapter, `${id} should be registered`).toBeDefined();

      const productIds = await idsFrom(adapter);
      expect(productIds.length, `${id} should return snapshot results`).toBeGreaterThan(0);

      for (const productId of productIds) {
        const parsed = parseProductId(productId, registry.ids());
        expect(parsed, `${productId} must verify`).not.toBeNull();
        expect(parsed!.store).toBe(adapter.manifest.id);
        expect(registry.get(parsed!.store)).toBe(adapter);
      }
    }
  });

  it("treats a store with no matches as an empty result, not an error", async () => {
    await expect(idsFrom(registry.get(SNAPSHOTTED_EMPTY)!)).resolves.toEqual([]);
  });

  it("resolves a simulated id the same way -- one rule for every mode", async () => {
    for (const adapter of registry.all().filter((a) => a.manifest.mode === "simulated")) {
      for (const productId of await idsFrom(adapter)) {
        const parsed = parseProductId(productId, registry.ids());
        expect(parsed).not.toBeNull();
        expect(parsed!.store).toBe(adapter.manifest.id);
      }
    }
  });

  it("serves tier-2 detail for an id that came out of tier-1 search", async () => {
    const adapter = registry.get("shp:deathwishcoffee.com")!;
    const [first] = await idsFrom(adapter);
    const parsed = parseProductId(first!, registry.ids())!;

    const resolved = registry.get(parsed.store)!;
    const detail = await resolved.detail(first!, ["description"], ctx);
    expect(detail.id).toBe(first);
    expect(detail.name.length).toBeGreaterThan(0);
    expect(detail.price.value).toBeGreaterThan(0);
    expect(detail.mode).toBe("native");

    // Detail must report its OWN upstream size. When this went unset the token
    // report credited tier-2 with the preceding search's bytes, which inflated
    // the headline saving on a call that fetched far less.
    expect(resolved.lastRawBytes).toBeGreaterThan(0);
  });

  it("refuses an id whose tag was tampered with", async () => {
    const adapter = registry.get("shp:deathwishcoffee.com")!;
    const [first] = await idsFrom(adapter);
    const tampered = `${first!.slice(0, -1)}${first!.endsWith("a") ? "b" : "a"}`;
    expect(parseProductId(tampered, registry.ids())).toBeNull();
  });

  it("refuses an id minted for a store the registry does not hold", () => {
    // Correctly formed, correctly tagged -- for a store nobody registered.
    expect(parseProductId("bk_shp-notastore-com_gid-shopify-product-1_abcd1234", registry.ids())).toBeNull();
  });
});
