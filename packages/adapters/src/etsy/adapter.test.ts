import { describe, expect, it } from "vitest";
import { EtsyAdapter } from "./adapter.js";
import type { AdapterCtx } from "../types.js";
import type { RenderResult } from "../stealth/browser.js";

function searchCard(opts: { listingId: string; title: string; priceHtml: string; href?: string; image?: string }): string {
  return `
    <div class="v2-listing-card">
      <a data-listing-id="${opts.listingId}" href="${opts.href ?? `https://www.etsy.com/listing/${opts.listingId}/test`}">
        <h3>${opts.title}</h3>
        ${opts.priceHtml}
        ${opts.image ? `<img src="${opts.image}" />` : ""}
      </a>
    </div>`;
}

function searchPage(cards: string[]): string {
  return `<html><body>${cards.join("\n")}</body></html>`;
}

function detailPage(opts: { title: string; priceHtml: string }): string {
  return `<html><body>
    <h1 data-buy-box-listing-title>${opts.title}</h1>
    <div data-test-id="price"><span class="currency-value">${opts.priceHtml}</span></div>
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

describe("real Etsy adapter", () => {
  it("is mode native discovery/detail only", () => {
    const a = new EtsyAdapter({ render: fakeRender({}) });
    expect(a.manifest.mode).toBe("native");
    expect(a.manifest.capabilities).toEqual(["discovery", "detail"]);
    expect((a as { buildCart?: unknown }).buildCart).toBeUndefined();
  });

  it("search parses listing cards into native products", async () => {
    const html = searchPage([
      searchCard({ listingId: "123456789", title: "Handmade Ceramic Mug", priceHtml: '<span class="currency-value">$24.99</span>' }),
      searchCard({ listingId: "987654321", title: "Vintage Wool Blanket", priceHtml: '<span class="currency-value">£45.00</span>' }),
    ]);
    const a = new EtsyAdapter({ render: fakeRender({ "etsy.com/search": html }) });
    const products = await a.search({ query: "mug" }, ctx());
    expect(products).toHaveLength(2);
    const mug = products.find((p) => p.name.includes("Ceramic"))!;
    expect(mug.price).toEqual({ value: 24.99, currency: "USD" });
    expect(mug.mode).toBe("native");
    expect(mug.source).toBe("etsy.com");
    const blanket = products.find((p) => p.name.includes("Blanket"))!;
    expect(blanket.price).toEqual({ value: 45, currency: "GBP" });
  });

  it("detail re-renders cached listing url", async () => {
    const searchHtml = searchPage([searchCard({ listingId: "123456789", title: "Handmade Ceramic Mug", priceHtml: '<span class="currency-value">$24.99</span>' })]);
    const detailHtml = detailPage({ title: "Handmade Ceramic Mug - Large", priceHtml: "$24.99" });
    const a = new EtsyAdapter({
      render: fakeRender({ "etsy.com/search": searchHtml, "listing/123456789": detailHtml }),
    });
    const [p] = await a.search({ query: "mug" }, ctx());
    const d = await a.detail(p!.id, [], ctx());
    expect(d.name).toContain("Ceramic Mug");
    expect(d.price).toEqual({ value: 24.99, currency: "USD" });
  });

  it("skips cards without parseable price", async () => {
    const html = searchPage([
      `<div class="v2-listing-card"><a data-listing-id="111" href="/listing/111"><h3>No price item</h3></a></div>`,
      searchCard({ listingId: "222", title: "Has price", priceHtml: '<span class="currency-value">$10.00</span>' }),
    ]);
    const a = new EtsyAdapter({ render: fakeRender({ "etsy.com/search": html }) });
    const products = await a.search({ query: "test" }, ctx());
    expect(products).toHaveLength(1);
    expect(products[0]!.name).toContain("Has price");
  });

  it("refuses unknown id", async () => {
    const a = new EtsyAdapter({ render: fakeRender({}) });
    await expect(a.detail("bk_etsy-etsy_nope_00000000", [], ctx())).rejects.toThrow(/server-minted/);
  });
});
