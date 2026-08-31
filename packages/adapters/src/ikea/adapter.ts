import {
  inferCategory,
  sanitiseProductName,
  sanitiseText,
  PROVENANCE_NOTE,
  type Include,
  type Product,
  type ProductDetail,
  type SearchQuery,
  type StoreManifest,
} from "@basketed/core";
import * as cheerio from "cheerio";
import { mintProductId } from "../ids.js";
import { renderPage, type RenderResult } from "../stealth/browser.js";
import type { AdapterCtx, StoreAdapter } from "../types.js";

/**
 * Real IKEA, S17.
 *
 * IKEA has no public product API reachable without a partner agreement, so
 * unlike Tesco (a JSON API) this adapter renders IKEA's own real pages in a
 * stealth browser (packages/adapters/src/stealth/browser.ts) and reads the
 * data straight out of the DOM they ship to a signed-out browser. Say that
 * plainly: this is scraping, not an API integration. It is still `mode:
 * "native"` because that field answers "whose data is this", not "how was it
 * fetched" -- every field here is exactly what ikea.com renders for anyone,
 * no login, no account, no scraped-through-a-proxy fabrication.
 *
 * Two very different real surfaces, verified live before this file was
 * written:
 *   - Search results (`/search/?q=`) embed the product data as plain HTML
 *     attributes on each card (`data-ref-id`, `data-price`, `data-currency`,
 *     `data-product-name`) -- no JSON blob to parse, so this reads those
 *     attributes directly rather than guessing at nested class names.
 *   - A product detail page embeds a full schema.org `Product` block as
 *     `<script type="application/ld+json">` -- name, price, availability,
 *     images, aggregate rating and reviews all in one place. That JSON-LD
 *     block is what detail() actually parses; it does not scrape the
 *     rendered price/rating widgets, which are the more fragile of the two.
 *
 * No cart, no handoff: IKEA's add-to-basket flow needs a session this
 * adapter has no way to hold (there is no "Sign in with IKEA" here, and even
 * signed in, checkout is a real payment nobody at our access tier can
 * complete programmatically). `capabilities` says exactly that.
 */

const SEARCH_BASE = "https://www.ikea.com/us/en/search/";
/**
 * IKEA's own item number is always the trailing digit run in a product's
 * canonical URL slug (search cards and the detail page's own JSON-LD `url`
 * both use this same slug shape) -- that is a stabler anchor than IKEA's
 * dotted `sku`/`mpn` ("401.042.94"), which is the same digits with
 * formatting that has to be stripped back out to match.
 */
const ITEM_NUMBER_FROM_URL = /-(\d+)\/?(?:[?#].*)?$/;

interface JsonLdOffer {
  price?: string;
  priceCurrency?: string;
  availability?: string;
  url?: string;
}

interface JsonLdReview {
  reviewBody?: string;
  reviewRating?: { ratingValue?: number };
}

interface JsonLdProduct {
  "@type"?: string;
  name?: string;
  description?: string;
  sku?: string;
  color?: string;
  depth?: string;
  height?: string;
  width?: string;
  image?: Array<{ contentUrl?: string }>;
  offers?: JsonLdOffer;
  aggregateRating?: { ratingValue?: string; reviewCount?: string };
  review?: JsonLdReview[];
}

/** Cached so detail() can re-render the exact page search found, by its real URL. */
interface Cached {
  itemNumber: string;
  url: string;
  name: string;
}

function itemNumberFromUrl(url: string): string | null {
  const match = ITEM_NUMBER_FROM_URL.exec(url.split("?")[0] ?? url);
  return match?.[1] ?? null;
}

export interface IkeaAdapterOptions {
  /**
   * Injectable in place of the real stealth-browser render, purely so the
   * unit suite can run against canned HTML instead of launching a real
   * Chromium and hitting the real network -- there is no ctx.http seam here
   * to mock against (see the file header), so this is that seam instead.
   */
  render?: (url: string) => Promise<RenderResult>;
}

export class IkeaAdapter implements StoreAdapter {
  readonly manifest: StoreManifest;
  readonly #cache = new Map<string, Cached>();
  readonly #render: (url: string) => Promise<RenderResult>;
  lastRawBytes = 0;

  constructor(opts: IkeaAdapterOptions = {}) {
    this.manifest = {
      id: "ikea:ikea",
      name: "IKEA",
      country: "US",
      currency: "USD",
      language: "en",
      categories: ["furniture"],
      mode: "native",
      auth: "none",
      capabilities: ["discovery", "detail"],
      domain: "ikea.com",
    };
    this.#render = opts.render ?? renderPage;
  }

  async search(q: SearchQuery, _ctx: AdapterCtx): Promise<Product[]> {
    const count = Math.min(q.maxResults ?? 10, 50);
    const url = `${SEARCH_BASE}?${new URLSearchParams({ q: q.query })}`;
    const { status, html } = await this.#render(url);
    this.lastRawBytes += html.length;
    if (status !== 200) throw new Error(`IKEA search returned HTTP ${status ?? "unknown"}.`);

    const $ = cheerio.load(html);
    const cards = $("[data-testid='plp-product-card']").toArray().slice(0, count);

    const products: Product[] = [];
    for (const el of cards) {
      const card = $(el);
      const itemNumber = card.attr("data-ref-id") ?? card.attr("data-product-number");
      const priceRaw = card.attr("data-price");
      const currency = (card.attr("data-currency") ?? this.manifest.currency).toUpperCase();
      const brand = card.attr("data-product-name") ?? "";
      const desc = card.find(".plp-price-module__description").first().text().trim();
      if (!itemNumber || !priceRaw) continue; // an incomplete card is skipped, not fabricated

      const rawName = [brand, desc].filter(Boolean).join(" ");
      const name = sanitiseProductName(rawName).text;
      const id = mintProductId(this.manifest.id, itemNumber);
      const href = card.find("a[href*='/p/']").first().attr("href") ?? "";
      this.#cache.set(id, { itemNumber, url: href, name });

      const product: Product = {
        id,
        name,
        price: { value: Number(priceRaw), currency },
        source: this.manifest.domain!,
        mode: "native",
      };
      const image = card.find("img").first().attr("src");
      if (image) product.image = image;
      if (href) product.url = href;
      const ratingCount = card.find(".plp-price-module__rating-label-count").first().text().replace(/[()]/g, "").trim();
      const ratingStyle = card.find(".plp-rating__stars").first().attr("style") ?? "";
      const ratingPct = /--rating:\s*([\d.]+)%/.exec(ratingStyle)?.[1];
      if (ratingPct && ratingCount) {
        product.rating = { score: (Number(ratingPct) / 100) * 5, count: Number(ratingCount) || 0 };
      }
      product.attrs = { cat: inferCategory(name) } as Product["attrs"];
      products.push(product);
    }
    return products;
  }

  async detail(id: string, include: Include[], _ctx: AdapterCtx): Promise<ProductDetail> {
    const cached = this.#cache.get(id);
    if (!cached) {
      throw new Error("Unknown product id for IKEA. Ids are server-minted; search first, then request detail.");
    }

    const { status, html } = await this.#render(cached.url);
    this.lastRawBytes += html.length;
    if (status !== 200) throw new Error(`IKEA product page returned HTTP ${status ?? "unknown"} for ${cached.itemNumber}.`);

    const $ = cheerio.load(html);
    const productLd = $("script[type='application/ld+json']")
      .toArray()
      .map((el) => {
        try {
          return JSON.parse($(el).html() ?? "") as JsonLdProduct;
        } catch {
          return null;
        }
      })
      .find((j): j is JsonLdProduct => j?.["@type"] === "Product");

    if (!productLd) {
      throw new Error(
        `IKEA's product page for ${cached.itemNumber} did not include the expected product data -- it may ` +
          `have been delisted, or IKEA changed the page layout this adapter was verified against.`,
      );
    }

    const name = sanitiseProductName(productLd.name ?? cached.name).text;
    const currency = (productLd.offers?.priceCurrency ?? this.manifest.currency).toUpperCase();
    const priceValue = Number(productLd.offers?.price ?? NaN);
    if (!Number.isFinite(priceValue)) {
      throw new Error(`IKEA's product page for ${cached.itemNumber} had no readable price.`);
    }

    const detail: ProductDetail = {
      id,
      name,
      price: { value: priceValue, currency },
      source: this.manifest.domain!,
      mode: "native",
    };
    const image = productLd.image?.[0]?.contentUrl;
    if (image) detail.image = image;
    detail.url = cached.url;
    detail.attrs = { cat: inferCategory(name) } as Product["attrs"];

    if (productLd.aggregateRating?.ratingValue) {
      detail.rating = {
        score: Number(productLd.aggregateRating.ratingValue),
        count: Number(productLd.aggregateRating.reviewCount ?? 0),
      };
    }

    if (include.includes("description") && productLd.description) {
      detail.description = sanitiseText(productLd.description, { maxLength: 2000 }).text;
    }
    if (include.includes("stock")) {
      detail.stock = productLd.offers?.availability?.includes("InStock") ? "in_stock" : "out_of_stock";
    }
    if (include.includes("specs")) {
      const specs: Record<string, string> = {};
      if (productLd.color) specs["color"] = productLd.color;
      if (productLd.depth) specs["depth"] = productLd.depth;
      if (productLd.height) specs["height"] = productLd.height;
      if (productLd.width) specs["width"] = productLd.width;
      if (Object.keys(specs).length) detail.specs = specs;
    }
    if (include.includes("reviews") && productLd.review?.length) {
      detail.reviews = productLd.review.slice(0, 3).map((r) => ({
        score: r.reviewRating?.ratingValue,
        text: sanitiseText(r.reviewBody, { maxLength: 200 }).text,
      }));
    }

    detail._meta = { provenance: PROVENANCE_NOTE };
    return detail;
  }
}

export { itemNumberFromUrl };
