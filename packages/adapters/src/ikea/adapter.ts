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
import type { RenderResult } from "../stealth/browser.js";
import type { AdapterCtx, StoreAdapter } from "../types.js";
import { IdCache } from "../id-cache.js";

/**
 * Real IKEA — plain HTTP, no browser.
 *
 * Search (`/search/?q=`) and detail pages are SSR HTML with the same markup
 * a signed-out browser sees. The previous stealth-browser render is no longer
 * needed — S22 fetches the same live pages via ctx.http with a desktop
 * User-Agent and parses the same data-attributes and JSON-LD block.
 *
 * Still `mode: "native"` — whose data, not how fetched. No cart/handoff.
 * `render` remains as a test seam for canned HTML.
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
  /** Test seam: canned HTML without live fetch. */
  render?: (url: string) => Promise<RenderResult>;
}

export class IkeaAdapter implements StoreAdapter {
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
    this.#render = opts.render;
  }

  async search(q: SearchQuery, ctx: AdapterCtx): Promise<Product[]> {
    this.lastRawBytes = 0;
    const count = Math.min(q.maxResults ?? 10, 50);
    const url = `${SEARCH_BASE}?${new URLSearchParams({ q: q.query })}`;
    let html: string;
    let status: number | null = 200;
    if (this.#render) {
      const res = await this.#render(url);
      html = res.html;
      status = res.status;
      this.lastRawBytes = html.length;
      if (status !== 200) throw new Error(`IKEA search returned HTTP ${status ?? "unknown"}.`);
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
      if (!res.ok) throw new Error(`IKEA search returned HTTP ${res.status}.`);
      status = res.status;
    }

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
      const rawHref = card.find("a[href*='/p/']").first().attr("href") ?? "";
      const href = rawHref ? new URL(rawHref, "https://www.ikea.com").toString() : "";
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

  async detail(id: string, include: Include[], ctx: AdapterCtx): Promise<ProductDetail> {
    const cached = this.#cache.get(id);
    if (!cached) {
      throw new Error("Unknown product id for IKEA. Ids are server-minted; search first, then request detail.");
    }
    if (!cached.url) throw new Error(`IKEA product ${cached.itemNumber} has no link to fetch.`);

    let html: string;
    let status: number | null = 200;
    if (this.#render) {
      const res = await this.#render(cached.url);
      html = res.html;
      status = res.status;
      this.lastRawBytes = html.length;
      if (status !== 200) throw new Error(`IKEA product page returned HTTP ${status ?? "unknown"} for ${cached.itemNumber}.`);
    } else {
      const res = await ctx.http(cached.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      html = await res.text();
      this.lastRawBytes = html.length;
      if (!res.ok) throw new Error(`IKEA product page returned HTTP ${res.status} for ${cached.itemNumber}.`);
      status = res.status;
    }

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
