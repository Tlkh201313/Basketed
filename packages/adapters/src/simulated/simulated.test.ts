import { describe, expect, it, beforeAll } from "vitest";
import { resolve } from "node:path";
import { SimulatedAdapter } from "./adapter.js";
import { shopifyCartPermalink, wooCartPermalink, productDeepLink } from "../permalinks.js";
import type { AdapterCtx } from "../types.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const ctx: AdapterCtx = { http: fetch, log: () => {}, snapshots: false };

let adapters: SimulatedAdapter[];
beforeAll(async () => {
  adapters = await SimulatedAdapter.loadAll(ROOT);
});

describe("simulated stores", () => {
  it("covers the retailers with no lawful automated route", () => {
    const ids = adapters.map((a) => a.manifest.id).sort();
    expect(ids).toEqual(["sim:amazon", "sim:costco", "sim:ikea", "sim:shopee", "sim:taobao", "sim:tesco"]);
  });

  it("stamps EVERY result as simulated -- provenance is never softened", async () => {
    for (const a of adapters) {
      const products = await a.search({ query: "coffee" }, ctx);
      for (const p of products) expect(p.mode).toBe("simulated");
    }
  });

  it("never claims `handoff`, because there is no real checkout behind it", () => {
    for (const a of adapters) {
      expect(a.manifest.capabilities).not.toContain("handoff");
      expect(a.manifest.capabilities).not.toContain("checkout");
    }
  });

  it("returns a null hand-off URL rather than passing a search link off as a cart", async () => {
    const tesco = adapters.find((a) => a.manifest.id === "sim:tesco")!;
    const [first] = await tesco.search({ query: "coffee" }, ctx);
    const cart = await tesco.buildCart([{ id: first!.id, quantity: 2 }], ctx);
    expect(cart.handoffUrl).toBeNull();
    expect(cart.cartId).toMatch(/^sim_cart_/);
    expect(cart.total.value).toBeCloseTo(first!.price.value * 2, 2);
  });

  it("quotes each store in its own currency", async () => {
    const byId = Object.fromEntries(adapters.map((a) => [a.manifest.id, a]));
    expect(byId["sim:tesco"]!.manifest.currency).toBe("GBP");
    expect(byId["sim:taobao"]!.manifest.currency).toBe("CNY");
    expect(byId["sim:shopee"]!.manifest.currency).toBe("SGD");
  });

  it("is deterministic, so the demo shows the same prices every run", async () => {
    const a = adapters.find((x) => x.manifest.id === "sim:tesco")!;
    const one = await a.search({ query: "coffee" }, ctx);
    const two = await a.search({ query: "coffee" }, ctx);
    expect(one.map((p) => p.price.value)).toEqual(two.map((p) => p.price.value));
  });
});

describe("purchase-route ladder", () => {
  it("builds a Shopify cart permalink with no network call, stripping the gid wrapper", () => {
    const route = shopifyCartPermalink("deathwishcoffee.com", [
      { variantId: "gid://shopify/ProductVariant/2413985169421", quantity: 2 },
    ]);
    expect(route.url).toBe("https://deathwishcoffee.com/cart/2413985169421:2");
    expect(route.rung).toBe(2);
  });

  it("supports multi-item permalinks and a discount code", () => {
    const route = shopifyCartPermalink(
      "example.com",
      [
        { variantId: "111", quantity: 1 },
        { variantId: "222", quantity: 3 },
      ],
      "SAVE10",
    );
    expect(route.url).toBe("https://example.com/cart/111:1,222:3?discount=SAVE10");
  });

  it("builds a WooCommerce add-to-cart link", () => {
    expect(wooCartPermalink("shop.example", "42", 2).url).toBe(
      "https://shop.example/?add-to-cart=42&quantity=2",
    );
  });

  it("labels a rung-4 link as a page, not a cart", () => {
    const route = productDeepLink("https://www.amazon.com/s?k=coffee", "Amazon");
    expect(route.rung).toBe(4);
    expect(route.reach).toContain("NOT a cart");
  });
});
