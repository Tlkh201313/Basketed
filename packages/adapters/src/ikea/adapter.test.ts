import { describe, expect, it } from "vitest";
import { IkeaAdapter } from "./adapter.js";
import type { AdapterCtx } from "../types.js";
import type { RenderResult } from "../stealth/browser.js";

/**
 * Mocked at the render boundary, not against a real browser -- this suite
 * (like every other adapter's) runs under the offline drill's network-cut
 * guard, and there is no ctx.http seam for IKEA to intercept (see adapter.ts's
 * header), so the injected `render` function IS the seam. These fixtures are
 * trimmed snippets of what ikea.com actually returned when this adapter was
 * verified live: a search card's real data-attribute shape, and a real
 * detail page's schema.org JSON-LD block (same LACK coffee table, item
 * 40104294, used for both probes).
 */

const SEARCH_HTML = `<!doctype html><html><body><ul class="plp-product-list__products">
<li>
  <div data-ref-id="40104294" data-product-number="40104294" data-price="29.99" data-currency="USD"
       data-product-name="LACK" data-testid="plp-product-card" class="plp-mastercard">
    <a href="https://www.ikea.com/us/en/p/lack-coffee-table-black-brown-40104294/" class="plp-product__image-link">
      <img src="https://www.ikea.com/us/en/images/products/lack-coffee-table-black-brown__57540_pe163122_s5.jpg?f=xxs">
    </a>
    <span class="plp-price-module__description">Coffee table, black-brown, 35 3/8x21 5/8 "</span>
    <button class="plp-rating">
      <span class="plp-rating__stars" style="--rating: 90%; --ceil-max-rating: 5;"></span>
      <span class="plp-price-module__rating-label-count">(4119)</span>
    </button>
  </div>
</li>
<li>
  <div data-ref-id="70527700" data-product-number="70527700" data-price="79.00" data-currency="USD"
       data-product-name="LISABO" data-testid="plp-product-card" class="plp-mastercard">
    <a href="https://www.ikea.com/us/en/p/lisabo-coffee-table-ash-veneer-70527700/" class="plp-product__image-link">
      <img src="https://www.ikea.com/us/en/images/products/lisabo-coffee-table-ash-veneer__0736440.jpg?f=xxs">
    </a>
    <span class="plp-price-module__description">Coffee table, ash veneer, 35x35 "</span>
    <button class="plp-rating">
      <span class="plp-rating__stars" style="--rating: 84%; --ceil-max-rating: 5;"></span>
      <span class="plp-price-module__rating-label-count">(212)</span>
    </button>
  </div>
</li>
</ul></body></html>`;

function detailHtml(opts: { itemNumber: string; sku: string; name: string; price: string }): string {
  const ld = {
    "@context": "https://schema.org/",
    "@type": "Product",
    aggregateRating: { "@type": "AggregateRating", ratingValue: "4.5", reviewCount: "4119" },
    brand: { "@type": "Brand", name: "IKEA" },
    category: "Coffee tables",
    color: "brown, black",
    depth: '35 3/8 "',
    description: `${opts.name}. Separate shelf for magazines, etc. helps you keep your things organized.`,
    height: '17 3/4 "',
    image: [{ "@type": "ImageObject", contentUrl: `https://www.ikea.com/us/en/images/products/${opts.itemNumber}.jpg` }],
    mpn: opts.sku,
    name: opts.name,
    offers: {
      "@type": "Offer",
      availability: "https://schema.org/InStock",
      price: opts.price,
      priceCurrency: "USD",
      url: `https://www.ikea.com/us/en/p/lack-coffee-table-black-brown-${opts.itemNumber}/`,
    },
    review: [
      {
        "@type": "Review",
        author: { "@type": "Person", name: "Desiree" },
        reviewBody: "The color is nice. But putting this together is a pain.",
        reviewRating: { "@type": "Rating", ratingValue: 3 },
      },
    ],
    sku: opts.sku,
    url: `https://www.ikea.com/us/en/p/lack-coffee-table-black-brown-${opts.itemNumber}/`,
    width: '21 5/8 "',
  };
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;
}

/** Real item numbers differ between the search page's bare digits and the detail page's dotted sku/mpn ("401.042.94" vs "40104294"). */
const LACK = { itemNumber: "40104294", sku: "401.042.94", name: 'LACK Coffee table - black-brown 35 3/8x21 5/8 "', price: "29.99" };
const LISABO = { itemNumber: "70527700", sku: "705.277.00", name: 'LISABO Coffee table - ash veneer 35x35 "', price: "79.00" };

function fakeRender(byUrl: Record<string, string>): (url: string) => Promise<RenderResult> {
  return async (url: string) => {
    for (const [key, html] of Object.entries(byUrl)) {
      if (url.includes(key)) return { status: 200, html, finalUrl: url };
    }
    throw new Error(`unexpected render call: ${url}`);
  };
}

function ctx(): AdapterCtx {
  return { http: fetch, log: () => {}, snapshots: false };
}

describe("real IKEA adapter (S17)", () => {
  it("is mode native, scrape-sourced, with only discovery and detail", () => {
    const adapter = new IkeaAdapter();
    expect(adapter.manifest.mode).toBe("native");
    expect(adapter.manifest.capabilities).toEqual(["discovery", "detail"]);
    // IKEA offers a session and gates nothing behind it (S22): a signed-in
    // request quotes the shopper's own store's stock, and a signed-out one
    // still has to answer, because it always did.
    const account = adapter.manifest.account;
    expect(account.kind).toBe("session");
    if (account.kind !== "session") return;
    expect(account.uses).toEqual([]);
    expect(account.improves).toEqual(["discovery", "detail"]);
  });

  it("search parses real-shaped product cards with decimal (not minor-unit) prices", async () => {
    const adapter = new IkeaAdapter({ render: fakeRender({ "/search/": SEARCH_HTML }) });
    const products = await adapter.search({ query: "coffee table" }, ctx());
    expect(products).toHaveLength(2);

    const lack = products.find((p) => p.name.includes("LACK"))!;
    expect(lack.price).toEqual({ value: 29.99, currency: "USD" });
    expect(lack.mode).toBe("native");
    expect(lack.source).toBe("ikea.com");
    expect(lack.rating).toEqual({ score: 4.5, count: 4119 });

    const lisabo = products.find((p) => p.name.includes("LISABO"))!;
    expect(lisabo.price).toEqual({ value: 79.0, currency: "USD" });
  });

  it("detail() re-hydrates by the item number in the product's own URL, not by search results order", async () => {
    const adapter = new IkeaAdapter({
      render: fakeRender({
        "/search/": SEARCH_HTML,
        "lack-coffee-table-black-brown-40104294": detailHtml(LACK),
        "lisabo-coffee-table-ash-veneer-70527700": detailHtml(LISABO),
      }),
    });
    const products = await adapter.search({ query: "coffee table" }, ctx());
    const lisabo = products.find((p) => p.name.includes("LISABO"))!;
    const lack = products.find((p) => p.name.includes("LACK"))!;

    // Fetching LISABO's detail must never return LACK's data, and vice versa --
    // catches an id/URL-conflation bug the same way Tesco's TPNB test does.
    const lisaboDetail = await adapter.detail(lisabo.id, ["description"], ctx());
    expect(lisaboDetail.name).toContain("LISABO");
    expect(lisaboDetail.price.value).toBe(79.0);
    expect(lisaboDetail.description).toContain("LISABO");

    const lackDetail = await adapter.detail(lack.id, ["description"], ctx());
    expect(lackDetail.name).toContain("LACK");
    expect(lackDetail.price.value).toBe(29.99);
  });

  it("detail() honours include flags and never fabricates fields the page doesn't have", async () => {
    const adapter = new IkeaAdapter({
      render: fakeRender({ "/search/": SEARCH_HTML, "40104294": detailHtml(LACK) }),
    });
    const [lack] = await adapter.search({ query: "coffee table" }, ctx());
    const withoutIncludes = await adapter.detail(lack!.id, [], ctx());
    expect(withoutIncludes.description).toBeUndefined();
    expect(withoutIncludes.specs).toBeUndefined();

    const withIncludes = await adapter.detail(lack!.id, ["description", "stock", "specs"], ctx());
    expect(withIncludes.description).toContain("LACK");
    expect(withIncludes.stock).toBe("in_stock");
    expect(withIncludes.specs?.color).toBe("brown, black");
  });

  it("detail() throws a clear error for an id never returned by search", async () => {
    const adapter = new IkeaAdapter({ render: fakeRender({ "/search/": SEARCH_HTML }) });
    await expect(adapter.detail("bk_ikea-ikea_99999999_deadbeef", ["stock"], ctx())).rejects.toThrow(
      /unknown product id.*search first/i,
    );
  });

  it("search fails honestly on a non-200 response instead of returning an empty success", async () => {
    const adapter = new IkeaAdapter({
      render: async (url: string) => ({ status: 503, html: "", finalUrl: url }),
    });
    await expect(adapter.search({ query: "coffee table" }, ctx())).rejects.toThrow(/503/);
  });
});
