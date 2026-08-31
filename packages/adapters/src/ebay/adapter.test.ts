import { describe, expect, it } from "vitest";
import { EbayAdapter } from "./adapter.js";
import type { AdapterCtx } from "../types.js";
import type { RenderResult } from "../stealth/browser.js";

function card(opts: { itemId: string; title: string; price: string; href?: string }): string {
  const href = opts.href ?? `https://www.ebay.com/itm/Test-Item-${opts.itemId}?hash=abc`;
  return `
    <li class="s-item">
      <a class="s-item__link" href="${href}"></a>
      <div class="s-item__title">${opts.title}</div>
      <span class="s-item__price">${opts.price}</span>
      <img class="s-item__image-img" src="https://i.ebayimg.com/images/${opts.itemId}.jpg" />
    </li>`;
}

function searchPage(cards: string[]): string {
  return `<html><body><ul class="srp-results">${cards.join("\n")}</ul></body></html>`;
}

function detailPage(opts: { title: string; price: string }): string {
  return `<html><body>
    <h1 class="x-item-title-label">${opts.title}</h1>
    <div class="x-price-primary"><span class="ux-textspans">${opts.price}</span></div>
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

describe("real eBay adapter", () => {
  it("is native discovery/detail only", () => {
    const a = new EbayAdapter({ render: fakeRender({}) });
    expect(a.manifest.mode).toBe("native");
    expect(a.manifest.capabilities).toEqual(["discovery", "detail"]);
  });

  it("search parses s-item cards", async () => {
    const html = searchPage([
      card({ itemId: "123456789012", title: "Wireless Earbuds ANC", price: "$29.99" }),
      card({ itemId: "987654321012", title: "Vintage Camera", price: "$149.50" }),
    ]);
    const a = new EbayAdapter({ render: fakeRender({ "ebay.com/sch": html }) });
    const products = await a.search({ query: "earbuds" }, ctx());
    expect(products).toHaveLength(2);
    const e = products.find((p) => p.name.includes("Earbuds"))!;
    expect(e.price).toEqual({ value: 29.99, currency: "USD" });
    expect(e.mode).toBe("native");
  });

  it("skips Shop on eBay placeholder", async () => {
    const html = searchPage([
      `<li class="s-item"><div class="s-item__title">Shop on eBay</div><span class="s-item__price">$0.00</span><a class="s-item__link" href="https://www.ebay.com/itm/111111111111"></a></li>`,
      card({ itemId: "222222222222", title: "Real Item", price: "$10.00" }),
    ]);
    const a = new EbayAdapter({ render: fakeRender({ "ebay.com/sch": html }) });
    const products = await a.search({ query: "test" }, ctx());
    expect(products).toHaveLength(1);
    expect(products[0]!.name).toBe("Real Item");
  });

  it("detail round-trips via cached itm url", async () => {
    const searchHtml = searchPage([card({ itemId: "123456789012", title: "Wireless Earbuds ANC", price: "$29.99" })]);
    const detailHtml = detailPage({ title: "Wireless Earbuds ANC - New", price: "$29.99" });
    const a = new EbayAdapter({ render: fakeRender({ "ebay.com/sch": searchHtml, "/itm/": detailHtml }) });
    const [p] = await a.search({ query: "earbuds" }, ctx());
    const d = await a.detail(p!.id, [], ctx());
    expect(d.name).toContain("Earbuds");
    expect(d.price).toEqual({ value: 29.99, currency: "USD" });
  });

  it("refuses unknown id", async () => {
    const a = new EbayAdapter({ render: fakeRender({}) });
    await expect(a.detail("bk_ebay-ebay_nope_00000000", [], ctx())).rejects.toThrow(/server-minted/);
  });
});
