import { describe, expect, it } from "vitest";
import { AmazonAdapter } from "./adapter.js";
import type { AdapterCtx } from "../types.js";
import type { RenderResult } from "../stealth/browser.js";

/**
 * Fixtures below are modeled on real amazon.com markup captured by hand
 * before this adapter was written (search cards under
 * `div[data-component-type="s-search-result"]`, detail page under
 * `#productTitle`/`#availability`/`#feature-bullets`). This suite never
 * drives a real browser -- `render` is injected -- so it runs under the
 * offline drill's network-cut guard like every other adapter's tests.
 */

function searchCard(opts: {
  asin: string;
  title: string;
  priceHtml: string; // one or more `.a-price .a-offscreen` spans, verbatim
  image?: string;
  ratingLabel?: string;
  reviewCount?: string;
}): string {
  return `
    <div data-component-type="s-search-result" data-asin="${opts.asin}">
      <h2><a><span>${opts.title}</span></a></h2>
      ${opts.priceHtml}
      ${opts.image ? `<img class="s-image" src="${opts.image}" />` : ""}
      ${opts.ratingLabel ? `<span aria-label="${opts.ratingLabel}"></span>` : ""}
      ${opts.reviewCount ? `<a href="#customerReviews"><span>${opts.reviewCount}</span></a>` : ""}
    </div>`;
}

function searchPage(cards: string[]): string {
  return `<html><body><div class="s-search-results">${cards.join("\n")}</div></body></html>`;
}

function detailPage(opts: {
  title: string;
  priceHtml: string;
  image?: string;
  availability?: string;
  bullets?: string[];
}): string {
  return `<html><body>
    <span id="productTitle">${opts.title}</span>
    <div id="corePrice_feature_div">${opts.priceHtml}</div>
    ${opts.image ? `<img id="landingImage" src="${opts.image}" />` : ""}
    <div id="availability"><span>${opts.availability ?? ""}</span></div>
    <div id="feature-bullets"><ul>
      ${(opts.bullets ?? []).map((b) => `<li><span class="a-list-item">${b}</span></li>`).join("\n")}
    </ul></div>
  </body></html>`;
}

const COFFEE_MAKER = {
  asin: "B01GJOMWVA",
  title: "Mr. Coffee 12-Cup Programmable Coffee Maker",
  usdPriceHtml: '<span class="a-price"><span class="a-offscreen">$34.99</span></span>',
  gbpPriceHtml:
    '<span class="a-price"><span class="a-offscreen">GBP 94.92</span></span>' +
    '<span class="a-price"><span class="a-offscreen">GBP 110.77</span></span>',
  image: "https://m.media-amazon.com/images/I/coffee-maker.jpg",
};

const KETTLE = {
  asin: "B08KETTLE1",
  title: "Electric Kettle | Stainless Steel, 1.7L",
  usdPriceHtml: '<span class="a-price"><span class="a-offscreen">$24.50</span></span>',
  image: "https://m.media-amazon.com/images/I/kettle.jpg",
};

function fakeRender(pages: Record<string, string>): (url: string) => Promise<RenderResult> {
  return async (url: string) => {
    for (const [needle, html] of Object.entries(pages)) {
      if (url.includes(needle)) return { status: 200, html, finalUrl: url };
    }
    throw new Error(`unexpected render request: ${url}`);
  };
}

function ctx(): AdapterCtx {
  return { http: fetch, log: () => {}, snapshots: false };
}

describe("real Amazon adapter (S16)", () => {
  it("is mode native with only discovery and detail claimed", () => {
    const adapter = new AmazonAdapter({ render: fakeRender({}) });
    expect(adapter.manifest.mode).toBe("native");
    expect(adapter.manifest.capabilities).toEqual(["discovery", "detail"]);
    expect((adapter as { buildCart?: unknown }).buildCart).toBeUndefined();
    expect((adapter as { handoff?: unknown }).handoff).toBeUndefined();
  });

  it("search parses real card markup into server-minted ids, using the price actually stated in the text", async () => {
    const html = searchPage([
      searchCard({
        asin: COFFEE_MAKER.asin,
        title: COFFEE_MAKER.title,
        // The same ASIN's card can carry GBP marketplace pricing even on
        // amazon.com -- the adapter must parse whatever currency is stated,
        // not assume the manifest's declared USD.
        priceHtml: COFFEE_MAKER.gbpPriceHtml,
        image: COFFEE_MAKER.image,
        ratingLabel: "4.6 out of 5 stars",
        reviewCount: "(50.2K)",
      }),
      searchCard({
        asin: KETTLE.asin,
        title: KETTLE.title,
        priceHtml: KETTLE.usdPriceHtml,
      }),
    ]);
    const adapter = new AmazonAdapter({ render: fakeRender({ "amazon.com/s": html }) });
    const products = await adapter.search({ query: "coffee maker" }, ctx());

    expect(products).toHaveLength(2);
    const coffee = products.find((p) => p.name.includes("Coffee Maker"))!;
    expect(coffee.price).toEqual({ value: 94.92, currency: "GBP" });
    expect(coffee.mode).toBe("native");
    expect(coffee.source).toBe("amazon.com");
    expect(coffee.rating).toEqual({ score: 4.6, count: 50200 });
    expect(coffee.image).toBe(COFFEE_MAKER.image);

    const kettle = products.find((p) => p.name.includes("Kettle"))!;
    expect(kettle.price).toEqual({ value: 24.5, currency: "USD" });
    // A literal "|" in the title is genuine SEO-stuffed product text, not
    // something the adapter should strip.
    expect(kettle.name).toContain("|");
  });

  it("detail() re-renders the specific product's own detail page, keyed by its cached ASIN", async () => {
    const searchHtml = searchPage([
      searchCard({ asin: COFFEE_MAKER.asin, title: COFFEE_MAKER.title, priceHtml: COFFEE_MAKER.gbpPriceHtml }),
      searchCard({ asin: KETTLE.asin, title: KETTLE.title, priceHtml: KETTLE.usdPriceHtml }),
    ]);
    const coffeeDetailHtml = detailPage({
      title: COFFEE_MAKER.title,
      priceHtml: COFFEE_MAKER.usdPriceHtml,
      image: COFFEE_MAKER.image,
      availability: "In Stock",
      bullets: ["12-cup programmable brewing", "Auto shut-off after 2 hours"],
    });
    const kettleDetailHtml = detailPage({
      title: KETTLE.title,
      priceHtml: KETTLE.usdPriceHtml,
      availability: "Only 3 left in stock",
    });

    const adapter = new AmazonAdapter({
      render: fakeRender({
        "amazon.com/s": searchHtml,
        [`dp/${COFFEE_MAKER.asin}`]: coffeeDetailHtml,
        [`dp/${KETTLE.asin}`]: kettleDetailHtml,
      }),
    });
    const products = await adapter.search({ query: "coffee maker" }, ctx());
    const kettleProduct = products.find((p) => p.name.includes("Kettle"))!;

    // Detail page uses USD for the coffee maker even though its search card
    // was GBP -- the real observed inconsistency between the two pages.
    const detail = await adapter.detail(kettleProduct.id, ["stock", "description"], ctx());
    expect(detail.name).toContain("Kettle");
    expect(detail.stock).toBe("Only 3 left in stock");
    expect(detail.description).toBeUndefined();
  });

  it("detail() honestly reports the real availability text and bullets, never fabricating them", async () => {
    const searchHtml = searchPage([
      searchCard({ asin: COFFEE_MAKER.asin, title: COFFEE_MAKER.title, priceHtml: COFFEE_MAKER.gbpPriceHtml }),
    ]);
    const coffeeDetailHtml = detailPage({
      title: COFFEE_MAKER.title,
      priceHtml: COFFEE_MAKER.usdPriceHtml,
      availability: "In Stock",
      bullets: ["12-cup programmable brewing", "Auto shut-off after 2 hours"],
    });
    const adapter = new AmazonAdapter({
      render: fakeRender({ "amazon.com/s": searchHtml, [`dp/${COFFEE_MAKER.asin}`]: coffeeDetailHtml }),
    });
    const [product] = await adapter.search({ query: "coffee maker" }, ctx());
    const detail = await adapter.detail(product!.id, ["stock", "description"], ctx());

    expect(detail.price).toEqual({ value: 34.99, currency: "USD" });
    expect(detail.stock).toBe("In Stock");
    expect(detail.description).toBe("12-cup programmable brewing Auto shut-off after 2 hours");
  });

  it("detail() refuses an id it never minted", async () => {
    const adapter = new AmazonAdapter({ render: fakeRender({}) });
    await expect(adapter.detail("bk_amz-amazon_nope_00000000", ["stock"], ctx())).rejects.toThrow(/server-minted/);
  });

  it("search skips a card with no confidently-parseable price rather than inventing one", async () => {
    const html = searchPage([
      `<div data-component-type="s-search-result" data-asin="${COFFEE_MAKER.asin}">
        <h2><a><span>${COFFEE_MAKER.title}</span></a></h2>
      </div>`,
      searchCard({ asin: KETTLE.asin, title: KETTLE.title, priceHtml: KETTLE.usdPriceHtml }),
    ]);
    const adapter = new AmazonAdapter({ render: fakeRender({ "amazon.com/s": html }) });
    const products = await adapter.search({ query: "coffee maker" }, ctx());
    expect(products).toHaveLength(1);
    expect(products[0]!.name).toContain("Kettle");
  });
});
