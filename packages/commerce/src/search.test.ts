import { describe, expect, it } from "vitest";
import { StoreRegistry, type AdapterCtx, type StoreAdapter } from "@basketed/adapters";
import type { Product } from "@basketed/core";
import { searchAll } from "./search.js";

/**
 * A signed-in answer and a signed-out answer are not the same answer.
 *
 * The fan-out caches each store's results for five minutes and serves that
 * cache when a later live call fails. Until S22 the key was the store id and
 * the query, which was fine while every request was anonymous. It is not fine
 * now that six stores attach the shopper's session when they have one: the
 * same words against the same store return their prices, their stock and
 * their delivery estimate. Sharing one entry between the two states means
 * connecting a store appears to do nothing for five minutes -- and,
 * worse, DISCONNECTING one keeps serving the account's own prices after the
 * account is gone.
 */

const ctx: AdapterCtx = { http: fetch, log: () => {}, snapshots: false };

function product(name: string, value: number): Product {
  return {
    id: "sim:x|abc",
    name,
    price: { value, currency: "GBP" },
    store: "Fake",
    mode: "native",
    source: "fake.test",
    available: true,
  } as unknown as Product;
}

/** Answers once with `name`, then fails every time after. */
function flakyAdapter(): StoreAdapter & { calls: number } {
  let calls = 0;
  const adapter = {
    manifest: {
      id: "fake:store",
      name: "Fake",
      country: "GB",
      currency: "GBP",
      language: "en",
      categories: ["general"],
      mode: "native",
      account: { kind: "none" },
      capabilities: ["discovery", "detail"],
      domain: "fake.test",
    },
    lastRawBytes: 10,
    get calls() {
      return calls;
    },
    async search() {
      calls += 1;
      if (calls > 1) throw new Error("upstream is down");
      return [product("signed-in price", 1)];
    },
    async detail() {
      return null;
    },
  };
  return adapter as unknown as StoreAdapter & { calls: number };
}

describe("the search cache is keyed on the session, not just the store (S22)", () => {
  it("does not serve a signed-in cached answer to a signed-out search", async () => {
    const registry = new StoreRegistry();
    const adapter = flakyAdapter();
    registry.register(adapter);
    const query = { query: `cache-tag-${Math.random()}`, maxResults: 2 };

    // Warm the cache as a connected shopper.
    const first = await searchAll(registry, query, ctx, { ctxFor: () => ({ ctx, tag: "auth" }) });
    expect(first.diagnostics.queried).toEqual(["fake:store"]);

    // Same words, same store, no session. The live call fails; the cached
    // signed-in answer must NOT stand in for it.
    const anon = await searchAll(registry, query, ctx, { ctxFor: () => ({ ctx, tag: "anon" }) });
    expect(anon.result.results).toEqual([]);
    expect(anon.diagnostics.failed).toEqual([{ store: "fake:store", reason: "upstream is down" }]);

    // Same tag as the warm-up, though, and stale-while-error is exactly what
    // a shopper wants: one flaky store must not empty the whole search.
    const again = await searchAll(registry, query, ctx, { ctxFor: () => ({ ctx, tag: "auth" }) });
    expect(again.diagnostics.failed).toEqual([]);
    expect(again.result.results).toHaveLength(1);
  });

  it("falls back to the shared context for a caller that names no per-store one", async () => {
    const registry = new StoreRegistry();
    registry.register(flakyAdapter());
    const out = await searchAll(registry, { query: `plain-${Math.random()}`, maxResults: 2 }, ctx);
    expect(out.diagnostics.queried).toEqual(["fake:store"]);
  });
});
