import { describe, expect, it } from "vitest";
import { BestBuyAdapter } from "./adapter.js";
import type { AdapterCtx } from "../types.js";
import type { RenderResult } from "../stealth/browser.js";

function card(opts: { sku: string; title: string; price: string }): string {
  const href = `https://www.bestbuy.com/site/test-product/p.p?skuId=${opts.sku}`;
  return `
    <li class="sku-item">
      <h4 class="sku-title"><a href="${href}">${opts.title}</a></h4>
      <div class="pricing-price__range">${opts.price}</div>
      <img src="https://pisces.bbystatic.com/image2/${opts.sku}.jpg" />
    </li>`;
}

function searchPage(cards: string[]): string {
  return `<html><body><ol class="sku-item-list">${cards.join("\n")}</ol></body></html>`;
}

function detailPage(opts: { title: string; price: string }): string {
  return `<html><body>
    <h1>${opts.title}</h1>
    <div data-testid="customer-price"><span>${opts.price}</span></div>
  </body></html>`;
}

function fakeRender(pages: Record<string, string>): (url: string) => Promise<RenderResult> {
  return async (url: string) => {
    for (const [needle, html] of Object.entries(pages)) {
      if (url.includes(needle)) return { status: 200, html, finalUrl: url };
    }
    throw new Error(`unexpected render: ${url}`);
  };
}
function ctx(): AdapterCtx {
  return { http: fetch, log: () => {}, snapshots: false };
}

describe("real Best Buy adapter", () => {
  it("is native discovery/detail/cart/handoff", () => {
    const a = new BestBuyAdapter({ render: fakeRender({}) });
    expect(a.manifest.mode).toBe("native");
    expect(a.manifest.capabilities).toEqual(["discovery", "detail", "cart", "handoff"]);
  });

  it("search parses sku-item cards", async () => {
    const html = searchPage([card({ sku: "1234567", title: "Sony WH-1000XM5 Headphones", price: "$399.99" })]);
    const a = new BestBuyAdapter({ render: fakeRender({ "bestbuy.com/site/searchpage": html }) });
    const products = await a.search({ query: "headphones" }, ctx());
    expect(products).toHaveLength(1);
    expect(products[0]!.name).toContain("Sony");
    expect(products[0]!.price).toEqual({ value: 399.99, currency: "USD" });
  });

  it("detail round-trips via sku url", async () => {
    const searchHtml = searchPage([card({ sku: "1234567", title: "Sony Headphones", price: "$399.99" })]);
    const detailHtml = detailPage({ title: "Sony WH-1000XM5 Headphones", price: "$399.99" });
    const a = new BestBuyAdapter({
      render: fakeRender({ "searchpage": searchHtml, "skuId=1234567": detailHtml }),
    });
    const [p] = await a.search({ query: "sony" }, ctx());
    const d = await a.detail(p!.id, [], ctx());
    expect(d.name).toContain("Sony");
    expect(d.price).toEqual({ value: 399.99, currency: "USD" });
  });

  it("skips cards without price", async () => {
    const html = searchPage([
      `<li class="sku-item"><h4 class="sku-title"><a href="https://www.bestbuy.com/site/a/p.p?skuId=1111111">No price</a></h4></li>`,
      card({ sku: "2222222", title: "Has price", price: "$10.00" }),
    ]);
    const a = new BestBuyAdapter({ render: fakeRender({ "searchpage": html }) });
    const products = await a.search({ query: "test" }, ctx());
    expect(products).toHaveLength(1);
  });

  it("refuses unknown id", async () => {
    const a = new BestBuyAdapter({ render: fakeRender({}) });
    await expect(a.detail("bk_bby-bestbuy_nope_00000000", [], ctx())).rejects.toThrow(/server-minted/);
  });

  it("buildCart creates a local cart with handoff to Best Buy cart", async () => {
    const searchHtml = searchPage([card({ sku: "1234567", title: "Sony Headphones", price: "$99.99" })]);
    const a = new BestBuyAdapter({ render: fakeRender({ "searchpage": searchHtml }) });
    const [p] = await a.search({ query: "sony" }, ctx());
    const cart = await a.buildCart!([{ id: p!.id, quantity: 1 }], ctx());
    expect(cart.lineItems).toHaveLength(1);
    expect(cart.total.value).toBe(99.99);
    expect(cart.handoffUrl).toBe("https://www.bestbuy.com/cart");
  });
});
