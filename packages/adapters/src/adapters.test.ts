import { describe, expect, it, beforeEach } from "vitest";
import { mintProductId, parseProductId, __setServerKey } from "./ids.js";
import { StoreRegistry } from "./registry.js";
import { overclaimedTiers, type StoreAdapter } from "./types.js";
import type { StoreManifest } from "@basketed/core";

const STORES = ["deathwishcoffee.com", "sim:tesco"];

beforeEach(() => __setServerKey(Buffer.from("test-key-for-deterministic-ids-0001")));

describe("product ids", () => {
  it("round-trips a minted id", () => {
    const id = mintProductId("deathwishcoffee.com", "gid://shopify/Product/263612097");
    const parsed = parseProductId(id, STORES);
    expect(parsed?.store).toBe("deathwishcoffee.com");
  });

  it("stays readable, because opaque UUIDs measurably hurt model precision", () => {
    const id = mintProductId("deathwishcoffee.com", "gid://shopify/Product/263612097");
    expect(id).toMatch(/^bk_deathwishcoffee-com_/);
    expect(id).toContain("263612097");
  });

  it("REJECTS a forged id -- an agent must not be able to invent a product it never saw", () => {
    const real = mintProductId("deathwishcoffee.com", "gid://shopify/Product/263612097");
    // Same shape, different product, tag copied from the real one.
    const forged = real.replace("263612097", "999999999");
    expect(parseProductId(forged, STORES)).toBeNull();
  });

  it("rejects an id whose tag has been tampered with", () => {
    const real = mintProductId("deathwishcoffee.com", "x1");
    const tampered = real.slice(0, -1) + (real.endsWith("a") ? "b" : "a");
    expect(parseProductId(tampered, STORES)).toBeNull();
  });

  it("rejects ids for stores that are not registered", () => {
    const id = mintProductId("evil-store.example", "x1");
    expect(parseProductId(id, STORES)).toBeNull();
  });
});

const manifest = (over: Partial<StoreManifest> = {}): StoreManifest => ({
  id: "shp:test",
  name: "Test",
  country: "US",
  currency: "USD",
  language: "en",
  categories: ["grocery"],
  mode: "native",
  auth: "none",
  capabilities: ["discovery", "detail"],
  ...over,
});

const adapter = (over: Partial<StoreAdapter> = {}): StoreAdapter =>
  ({
    manifest: manifest(),
    search: async () => [],
    detail: async () => ({}) as never,
    ...over,
  }) as StoreAdapter;

describe("registry honesty constraint", () => {
  it("accepts an adapter whose claims match its implementation", () => {
    const r = new StoreRegistry();
    expect(() => r.register(adapter())).not.toThrow();
    expect(r.ids()).toEqual(["shp:test"]);
  });

  it("REFUSES an adapter that claims a tier it does not implement", () => {
    const r = new StoreRegistry();
    const liar = adapter({ manifest: manifest({ capabilities: ["discovery", "detail", "cart"] }) });
    expect(overclaimedTiers(liar)).toEqual(["cart"]);
    expect(() => r.register(liar)).toThrow(/claims capabilities it does not implement/);
  });

  it("REFUSES any adapter claiming `checkout` -- nobody at our access tier can complete a payment", () => {
    const r = new StoreRegistry();
    const liar = adapter({ manifest: manifest({ capabilities: ["discovery", "detail", "checkout"] }) });
    expect(() => r.register(liar)).toThrow(/checkout/);
  });

  it("rejects duplicate store ids", () => {
    const r = new StoreRegistry();
    r.register(adapter());
    expect(() => r.register(adapter())).toThrow(/Duplicate/);
  });

  it("keeps a key-less provider store visible and flagged, never silently hidden", () => {
    const r = new StoreRegistry();
    r.register(adapter({ manifest: manifest({ id: "prv:tesco", mode: "provider" }) }), "needs_key");
    const rows = r.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("needs_key");
    expect(rows[0]?.mode).toBe("provider");
  });

  it("filters by mode so a caller can ask for real data only", () => {
    const r = new StoreRegistry();
    r.register(adapter({ manifest: manifest({ id: "shp:a", mode: "native" }) }));
    r.register(adapter({ manifest: manifest({ id: "sim:b", mode: "simulated" }) }));
    expect(r.list({ mode: "native" }).map((s) => s.id)).toEqual(["shp:a"]);
  });
});
