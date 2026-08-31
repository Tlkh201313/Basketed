import * as cheerio from "cheerio";
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
import { renderPage, type RenderResult } from "../stealth/browser.js";
import type { AdapterCtx, StoreAdapter } from "../types.js";

/**
 * Real Amazon, S16 store-roster expansion.
 *
 * Unlike Tesco (a JSON API, no auth, no scraping at all), Amazon has none of
 * that reachable at our access tier -- there is no public product-search API
 * a signed-out client can call. What IS reachable is exactly what a signed-out
 * human sees: amazon.com/s and amazon.com/dp/<ASIN>, rendered in a real,
 * patched Chromium (see ../stealth/browser.ts) and parsed with cheerio. That
 * is genuinely scraping, and this file says so rather than dressing it up.
 *
 * It is still `mode: "native"`, and that claim is about WHOSE data this is,
 * not HOW it was fetched: every field below came from Amazon's own live page,
 * reaching this adapter the same way it reaches a signed-out browser. Nothing
 * is proxied through a third-party catalog and nothing is invented.
 *
 * No ctx.http here, by construction: AdapterCtx.http exists specifically so
 * an adapter can be handed a pre-authenticated request pipeline without ever
 * seeing the credential behind it (see types.ts). There is no credential for
 * Amazon search/detail -- these are pages a browser with no account can
 * already load -- so there is nothing for ctx.http to intercept, and driving
 * a real browser instead is not a workaround for the trust boundary, it's
 * just what unauthenticated Amazon requires. Cart/checkout would need the
 * shopper's own signed-in session, which is out of scope here (no capability
 * claimed for it), for the same reason the Tesco basket needs a bearer token.
 *
 * `render` is injectable so tests never touch the network -- the offline-drill
 * seam for a browser-automation adapter, playing the same role ctx.http's
 * fake plays for Tesco's tests.
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
  /** Test seam: inject a fake renderer instead of driving a real browser. */
  render?: (url: string) => Promise<RenderResult>;
}

export class AmazonAdapter implements StoreAdapter {
  readonly manifest: StoreManifest;
  readonly #cache = new Map<string, Cached>();
  readonly #render: (url: string) => Promise<RenderResult>;
  lastRawBytes = 0;

  constructor(opts: AmazonAdapterOptions = {}) {
    this.#render = opts.render ?? renderPage;
    this.manifest = {
      id: "amz:amazon",
      name: "Amazon",
      country: "US",
      currency: "USD",
      language: "en",
      categories: ["general"],
      mode: "native",
      auth: "none",
      capabilities: ["discovery", "detail"],
      domain: "amazon.com",
    };
  }

  async search(q: SearchQuery, ctx: AdapterCtx): Promise<Product[]> {
    void ctx;
    this.lastRawBytes = 0;
    const count = Math.min(q.maxResults ?? 10, 50);
    const url = `${SEARCH_URL}?${new URLSearchParams({ k: q.query })}`;
    const { html } = await this.#render(url);
    this.lastRawBytes = html.length;

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
    void ctx;
    const cached = this.#cache.get(id);
    if (!cached) {
      throw new Error("Unknown product id for Amazon. Ids are server-minted; search first, then request detail.");
    }

    const { html } = await this.#render(`${DETAIL_URL}${cached.asin}`);
    this.lastRawBytes = html.length;
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
