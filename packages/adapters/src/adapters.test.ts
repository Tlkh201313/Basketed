import { describe, expect, it, beforeEach } from "vitest";
import { mintProductId, parseProductId, __setServerKey } from "./ids.js";
import { StoreRegistry } from "./registry.js";
import { resolveHandoffUrl } from "./shopify-ucp/client.js";
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
  account: { kind: "none" },
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

  /*
   * Slots are two operations, and half of the pair is not a delivery window
   * -- listing one an agent cannot then book is a tour of a shop with no till.
   * The registry is where that is caught, before the store ever loads.
   */
  it("REFUSES a store that can list delivery slots but not book one", () => {
    const r = new StoreRegistry();
    const halfway = adapter({
      manifest: manifest({ capabilities: ["discovery", "detail", "slots"] }),
      slots: async () => [],
    });
    expect(overclaimedTiers(halfway)).toEqual(["slots"]);
    expect(() => r.register(halfway)).toThrow(/claims capabilities it does not implement/);
  });

  it("accepts a store that implements both halves of the slots tier", () => {
    const r = new StoreRegistry();
    const honest = adapter({
      manifest: manifest({ capabilities: ["discovery", "detail", "slots"] }),
      slots: async () => [],
      bookSlot: async () => ({ slotId: "s", start: "", end: "", expiresAt: null }),
    });
    expect(overclaimedTiers(honest)).toEqual([]);
    expect(() => r.register(honest)).not.toThrow();
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

/* ------------------------------------------------- the hand-off URL (S11) */

describe("a hand-off URL is a link we tell a person to click", () => {
  const MERCHANT = "deathwishcoffee.com";

  it("takes continue_url on the merchant's own domain", () => {
    const url = "https://deathwishcoffee.com/cart/c/abc123";
    expect(resolveHandoffUrl({ continue_url: url }, MERCHANT)).toBe(url);
  });

  it("takes the myshopify.com host a real Shopify checkout actually uses", () => {
    // The obvious rule -- same host as the store -- would refuse every real
    // hand-off, which is why this case is a test and not an assumption.
    const url = "https://deathwishcoffee.myshopify.com/cart/c/hWNG54reiyTUL";
    expect(resolveHandoffUrl({ continue_url: url }, MERCHANT)).toBe(url);
  });

  it("refuses a continue_url pointing at somebody else entirely", () => {
    const seen: string[] = [];
    const url = "https://evil.example/checkouts/c/abc123";
    expect(resolveHandoffUrl({ continue_url: url }, MERCHANT, (m) => seen.push(m))).toBeNull();
    expect(seen.join(" ")).toMatch(/refused/);
  });

  it("refuses http, however plausible the host", () => {
    expect(resolveHandoffUrl({ continue_url: "http://deathwishcoffee.com/cart/c/abc" }, MERCHANT)).toBeNull();
  });

  it("refuses a look-alike that merely ends in the merchant's name", () => {
    expect(resolveHandoffUrl({ continue_url: "https://deathwishcoffee.com.evil.example/cart/c/a" }, MERCHANT))
      .toBeNull();
  });

  it("will not let the regex fallback pick a URL out of merchant prose", () => {
    // The fallback scans a JSON blob the MERCHANT wrote. Without a host check,
    // any cart-shaped string anywhere in the response became the link.
    const payload = {
      status: "ok",
      note: "See https://phish.example/checkouts/c/steal for details",
    };
    expect(resolveHandoffUrl(payload, MERCHANT)).toBeNull();
  });

  it("still falls back when the renamed field is the merchant's own URL", () => {
    const seen: string[] = [];
    const payload = { checkout_continue: "https://deathwishcoffee.myshopify.com/checkouts/c/abc" };
    expect(resolveHandoffUrl(payload, MERCHANT, (m) => seen.push(m))).toBe(payload.checkout_continue);
    expect(seen.join(" ")).toMatch(/renamed/);
  });

  it("returns null rather than throwing on a payload with nothing in it", () => {
    expect(resolveHandoffUrl({}, MERCHANT)).toBeNull();
  });
});
