import * as cheerio from "cheerio";
import { assertPageUsable, pageHasResults, type PageSpec } from "../blocked.js";

/**
 * What a rendered Amazon results page has and a block page does not.
 *
 * `s-main-slot` is the results container: a genuine zero-result search still
 * has it, which is exactly the line being drawn -- absent means we are not
 * looking at a results page at all.
 */
const SEARCH_PAGE: PageSpec = {
  store: "Amazon",
  page: "search",
  expect: [/s-main-slot/, /data-component-type="s-search-result"/, /id="search"/],
  empty: [/No results for/i, /did not match any products/i],
  blocked: [/Enter the characters you see below/i, /api-services-support@amazon\.com/i],
};

const DETAIL_PAGE: PageSpec = {
  store: "Amazon",
  page: "product page",
  expect: [/id="productTitle"/, /id="dp"/, /id="ppd"/],
  blocked: [/Enter the characters you see below/i],
};
import {
  inferCategory,
  sanitiseProductName,
  sanitiseText,
  PROVENANCE_NOTE,
  type Include,
  type Product,
  type ProductDetail,
  type Rating,
  type SearchQuery,
  type StoreManifest,
} from "@basketed/core";
import { mintProductId } from "../ids.js";
import type { RenderResult } from "../stealth/browser.js";
import type { AdapterCtx, StoreAdapter } from "../types.js";
import { IdCache } from "../id-cache.js";

/**
 * Real Amazon — plain HTTP, no browser.
 *
 * Unlike Tesco (a JSON API), Amazon has no public search API at our tier,
 * but amazon.com/s and amazon.com/dp/<ASIN> are SSR HTML reachable via
 * plain HTTP with a desktop User-Agent. The previous stealth-browser render
 * is no longer needed — S22 switches to ctx.http so all 24 stores work
 * without Chromium, and the adapter still parses the same live markup a
 * signed-out browser would see.
 *
 * Still `mode: "native"` — whose data, not how fetched. No credential for
 * search/detail, so ctx.http is just the global fetch pipeline. Cart would
 * need a signed-in session, out of scope.
 *
 * `render` remains as a test seam: tests inject canned HTML without needing
 * a fake fetch. Live path uses ctx.http.
 */

const SEARCH_URL = "https://www.amazon.com/s";
const DETAIL_URL = "https://www.amazon.com/dp/";

const CURRENCY_SYMBOLS: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR", "¥": "JPY" };

/**
 * Amazon's own price text is not reliably in the manifest's declared currency
 * -- a marketplace listing can show GBP pricing on amazon.com depending on
 * the seller, even for a US-catalog search. Parsing whatever currency the
 * page actually states (rather than assuming USD because the manifest says
 * so) is the honest option; assuming would silently mis-price a result.
 */
function parsePrice(text: string): { value: number; currency: string } | null {
  const trimmed = text.trim();
  const codeMatch = /^([A-Z]{3})\s*([\d,]+\.?\d*)$/.exec(trimmed);
  if (codeMatch) {
    const value = Number(codeMatch[2]!.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) return { value, currency: codeMatch[1]! };
  }
  const symbolMatch = /^([$£€¥])\s*([\d,]+\.?\d*)$/.exec(trimmed);
  if (symbolMatch) {
    const currency = CURRENCY_SYMBOLS[symbolMatch[1]!];
    const value = Number(symbolMatch[2]!.replace(/,/g, ""));
    if (currency && Number.isFinite(value) && value > 0) return { value, currency };
  }
  return null;
}

function parseCount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/[(),]/g, "").trim();
  const m = /^([\d.]+)\s*([KM])?$/i.exec(cleaned);
  if (!m) return undefined;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return undefined;
  const suffix = m[2]?.toUpperCase();
  const mult = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : 1;
  return Math.round(base * mult);
}

function parseRating(ariaLabel: string | undefined, countText: string | undefined): Rating | undefined {
  if (!ariaLabel) return undefined;
  const m = /^([\d.]+)\s+out of 5 stars/.exec(ariaLabel.trim());
  if (!m) return undefined;
  const score = Number(m[1]);
  const count = parseCount(countText);
  if (!Number.isFinite(score) || count === undefined) return undefined;
  return { score, count };
}

/** Cached so detail() can re-render the exact page search found, by ASIN. */
interface Cached {
  asin: string;
  name: string;
}

export interface AmazonAdapterOptions {
  /** Test seam: inject a fake renderer instead of live fetch. */
  render?: (url: string) => Promise<RenderResult>;
}

export class AmazonAdapter implements StoreAdapter {
  readonly manifest: StoreManifest;
  #idCache: IdCache<Cached> | undefined;
  /**
   * Native ids for the handles this adapter has minted, persisted between
   * runs -- see id-cache.ts. Lazy because it is keyed on `this.manifest.id`,
   * which the constructor has not set when field initialisers run.
   */
  get #cache(): IdCache<Cached> {
    return (this.#idCache ??= new IdCache<Cached>(this.manifest.id));
  }
  readonly #render?: (url: string) => Promise<RenderResult>;
  lastRawBytes = 0;

  constructor(opts: AmazonAdapterOptions = {}) {
    this.#render = opts.render;
    this.manifest = {
      id: "amz:amazon",
      name: "Amazon",
      country: "US",
      currency: "USD",
      language: "en",
      categories: ["general"],
      mode: "native",
      account: { kind: "none" },
      capabilities: ["discovery", "detail"],
      domain: "amazon.com",
    };
  }

  async search(q: SearchQuery, ctx: AdapterCtx): Promise<Product[]> {
    this.lastRawBytes = 0;
    const count = Math.min(q.maxResults ?? 10, 50);
    const url = `${SEARCH_URL}?${new URLSearchParams({ k: q.query })}`;
    let html: string;
    if (this.#render) {
      const res = await this.#render(url);
      html = res.html;
      this.lastRawBytes = html.length;
      if (res.status !== null && res.status >= 400) throw new Error(`Amazon search returned HTTP ${res.status}.`);
    } else {
      const res = await ctx.http(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      html = await res.text();
      this.lastRawBytes = html.length;
      if (!res.ok) throw new Error(`Amazon search returned HTTP ${res.status}.`);
    }

    // Blocked and "we changed our markup" both used to arrive here as an
    // empty product list. See blocked.ts.
    if (!pageHasResults(html, SEARCH_PAGE)) return [];

    const $ = cheerio.load(html);
    const cards = $('div[data-component-type="s-search-result"]');
    const products: Product[] = [];
    cards.each((_i, el) => {
      if (products.length >= count) return;
      const product = this.#normaliseCard($, $(el));
      if (product) products.push(product);
    });
    return products;
  }

  #normaliseCard($: cheerio.CheerioAPI, card: ReturnType<cheerio.CheerioAPI>): Product | null {
    const asin = card.attr("data-asin");
    if (!asin) return null;
    const titleRaw = card.find("h2").first().text().trim();
    if (!titleRaw) return null;
    const priceText = card.find(".a-price .a-offscreen").first().text();
    const price = parsePrice(priceText);
    // No confidently-parsed price -- skip rather than invent one. A sponsored
    // slot or a "see options" card with no single price is a real, common
    // shape on this page, not a parsing bug to paper over.
    if (!price) return null;

    const name = sanitiseProductName(titleRaw).text;
    const id = mintProductId(this.manifest.id, asin);
    this.#cache.set(id, { asin, name });

    const image = card.find("img.s-image").first().attr("src");
    const ratingLabel = card.find('[aria-label*="out of 5 stars"]').first().attr("aria-label");
    const countText = card.find('a[href*="#customerReviews"] span').first().text();
    const rating = parseRating(ratingLabel, countText);

    const product: Product = {
      id,
      name,
      price: { value: price.value, currency: price.currency },
      source: this.manifest.domain!,
      mode: "native",
    };
    if (image) product.image = image;
    if (rating) product.rating = rating;
    product.attrs = { cat: inferCategory(name) } as Product["attrs"];
    return product;
  }

  async detail(id: string, include: Include[], ctx: AdapterCtx): Promise<ProductDetail> {
    const cached = this.#cache.get(id);
    if (!cached) {
      throw new Error("Unknown product id for Amazon. Ids are server-minted; search first, then request detail.");
    }

    let html: string;
    if (this.#render) {
      const res = await this.#render(`${DETAIL_URL}${cached.asin}`);
      html = res.html;
      this.lastRawBytes = html.length;
      if (res.status !== null && res.status >= 400) throw new Error(`Amazon product page returned HTTP ${res.status} for ${cached.asin}.`);
    } else {
      const res = await ctx.http(`${DETAIL_URL}${cached.asin}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      html = await res.text();
      this.lastRawBytes = html.length;
      if (!res.ok) throw new Error(`Amazon product page returned HTTP ${res.status} for ${cached.asin}.`);
    }
    assertPageUsable(html, DETAIL_PAGE);
    const $ = cheerio.load(html);

    const titleRaw = $("#productTitle").text().trim();
    if (!titleRaw) {
      throw new Error(
        `Amazon returned no usable product data for ${cached.asin} -- the page may be blocked, removed, or region-restricted.`,
      );
    }
    const name = sanitiseProductName(titleRaw).text;

    const priceText =
      $("#corePrice_feature_div .a-price .a-offscreen").first().text() ||
      $(".a-price .a-offscreen").first().text();
    const price = parsePrice(priceText);
    if (!price) {
      throw new Error(`Amazon returned no parseable price for ${cached.asin}.`);
    }

    const detail: ProductDetail = {
      id,
      name,
      price: { value: price.value, currency: price.currency },
      source: this.manifest.domain!,
      mode: "native",
      attrs: { cat: inferCategory(name) } as ProductDetail["attrs"],
    };

    const image = $("#landingImage").attr("src") ?? $("#imgTagWrapperId img").attr("src");
    if (image) detail.image = image;

    if (include.includes("description")) {
      const bullets = $("#feature-bullets li span.a-list-item")
        .map((_i, el) => $(el).text().trim())
        .get()
        .filter(Boolean);
      if (bullets.length) detail.description = sanitiseText(bullets.join("\n")).text;
    }

    if (include.includes("stock")) {
      // Real text, not assumed -- if Amazon doesn't say, we don't guess.
      const availability = $("#availability span").first().text().trim();
      if (availability) detail.stock = availability;
    }

    detail._meta = { provenance: PROVENANCE_NOTE };
    return detail;
  }
}
