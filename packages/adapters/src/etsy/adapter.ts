import * as cheerio from "cheerio";
import { assertPageUsable, pageHasResults, type PageSpec } from "../blocked.js";

/**
 * Etsy's search results carry data-listing-id on every card, and the search
 * wrapper is present even when nothing matched. The `empty` phrases are Etsy's
 * own; without one of them, "no cards" means our selectors, not their stock.
 */
const SEARCH_PAGE: PageSpec = {
  store: "Etsy",
  page: "search",
  expect: [/data-listing-id/, /search-results/, /wt-grid/, /listing-card/],
  empty: [/no results/i, /found no results/i, /couldn(?:'|&#39;|’)t find any/i],
};

const DETAIL_PAGE: PageSpec = {
  store: "Etsy",
  page: "listing page",
  expect: [/data-buy-box-listing-title/, /data-listing-id/, /application\/ld\+json/, /listing-page/],
};
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
import { mintProductId } from "../ids.js";
import type { RenderResult } from "../stealth/browser.js";
import type { AdapterCtx, StoreAdapter } from "../types.js";
import { IdCache } from "../id-cache.js";

/**
 * Real Etsy — plain HTTP, no browser.
 *
 * Etsy search and listing pages are SSR HTML reachable via plain HTTP with
 * a desktop User-Agent. S22 switches from stealth render to ctx.http so all
 * 24 stores work without Chromium.
 *
 * Still `mode: "native"` — whose data, not how fetched. No cart.
 * `render` stays as test seam for canned HTML.
 */

const SEARCH_BASE = "https://www.etsy.com/search";
const LISTING_BASE = "https://www.etsy.com/listing/";

const CURRENCY_SYMBOLS: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR", "¥": "JPY" };

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
  // Fallback: "$24.99" inside longer string like "Price: $24.99"
  const loose = /([$£€¥])\s*([\d,]+\.\d{2})/.exec(trimmed);
  if (loose) {
    const currency = CURRENCY_SYMBOLS[loose[1]!];
    const value = Number(loose[2]!.replace(/,/g, ""));
    if (currency && Number.isFinite(value)) return { value, currency };
  }
  return null;
}

interface Cached {
  listingId: string;
  url: string;
  name: string;
}

export interface EtsyAdapterOptions {
  render?: (url: string) => Promise<RenderResult>;
}

export class EtsyAdapter implements StoreAdapter {
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

  constructor(opts: EtsyAdapterOptions = {}) {
    this.#render = opts.render;
    this.manifest = {
      id: "etsy:etsy",
      name: "Etsy",
      country: "US",
      currency: "USD",
      language: "en",
      categories: ["general", "apparel", "furniture"],
      mode: "native",
      account: { kind: "none" },
      capabilities: ["discovery", "detail"],
      domain: "etsy.com",
    };
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
      if (status !== null && status >= 400) throw new Error(`Etsy search returned HTTP ${status}.`);
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
      if (!res.ok) {
        // Cloudflare 403 — try stealth browser as fallback if available (real data, no simulated fallback)
        if (res.status === 403) {
          try {
            const { renderPage } = await import("../stealth/browser.js");
            const r = await renderPage(url);
            html = r.html;
            status = r.status;
            this.lastRawBytes = html.length;
            if (status !== null && status >= 400) throw new Error(`Etsy search returned HTTP ${status} (stealth).`);
          } catch {
            throw new Error(`Etsy search returned HTTP ${res.status}.`);
          }
        } else {
          throw new Error(`Etsy search returned HTTP ${res.status}.`);
        }
      } else {
        status = res.status;
      }
    }

    // Etsy 403s aggressively. A refusal must reach failed[], not read as
    // "Etsy has nothing like that". See blocked.ts.
    if (!pageHasResults(html, SEARCH_PAGE)) return [];

    const $ = cheerio.load(html);
    const products: Product[] = [];

    // Primary: listing cards with data-listing-id (real etsy.com/search markup)
    const cards = $('a[data-listing-id], [data-listing-id]').toArray();
    // Fallback for alternative layouts or fixture HTML
    const fallback = cards.length ? cards : $('li.wt-list-unstyled, div.v2-listing-card, div[data-test-id="listing-card"]').toArray();

    for (const el of fallback) {
      if (products.length >= count) break;
      const card = $(el);
      // If fallback container, find inner link
      const linkEl = card.is('a[data-listing-id]') ? card : card.find('a[data-listing-id]').first();
      const listingId = linkEl.attr('data-listing-id') ?? card.attr('data-listing-id') ?? "";
      if (!listingId) continue;

      const href = linkEl.attr('href') ?? card.find('a[href*="/listing/"]').first().attr('href') ?? `${LISTING_BASE}${listingId}`;
      const absoluteUrl = href ? new URL(href, "https://www.etsy.com").toString() : `${LISTING_BASE}${listingId}`;

      // Title: try several selectors used live
      const titleRaw =
        card.find('h3').first().text().trim() ||
        card.find('[data-test-id="listing-title"]').first().text().trim() ||
        linkEl.attr('title')?.trim() ||
        card.text().trim().split("\n")[0]?.trim() ||
        "";
      if (!titleRaw) continue;

      // Price: look for currency-value or data-test-id price
      const priceText =
        card.find('.currency-value').first().text().trim() ||
        card.find('[data-test-id="price"]').first().text().trim() ||
        card.find('.wt-text-title-01').first().text().trim() ||
        card.text();

      const parsed = parsePrice(priceText);
      // If loose parse failed, try to find $xx.xx inside card text
      const price = parsed ?? parsePrice(card.find('.n-listing-card__price').text() ?? "");
      if (!price) continue;

      const name = sanitiseProductName(titleRaw).text;
      const id = mintProductId(this.manifest.id, listingId);
      this.#cache.set(id, { listingId, url: absoluteUrl, name });

      const image = card.find('img').first().attr('src') ?? card.find('img').first().attr('data-src') ?? undefined;

      const product: Product = {
        id,
        name,
        price: { value: price.value, currency: price.currency },
        source: this.manifest.domain!,
        mode: "native",
      };
      if (image) product.image = image;
      if (absoluteUrl) product.url = absoluteUrl;
      product.attrs = { cat: inferCategory(name) } as Product["attrs"];
      products.push(product);
    }
    return products;
  }

  async detail(id: string, include: Include[], ctx: AdapterCtx): Promise<ProductDetail> {
    const cached = this.#cache.get(id);
    if (!cached) throw new Error("Unknown product id for Etsy. Ids are server-minted; search first, then request detail.");
    if (!cached.url) throw new Error(`Etsy product ${cached.listingId} has no link to fetch.`);

    this.lastRawBytes = 0;
    let html: string;
    let status: number | null = 200;
    if (this.#render) {
      const res = await this.#render(cached.url);
      html = res.html;
      status = res.status;
      this.lastRawBytes = html.length;
      if (status !== null && status >= 400) throw new Error(`Etsy product page returned HTTP ${status} for ${cached.listingId}.`);
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
      if (!res.ok) {
        if (res.status === 403) {
          try {
            const { renderPage } = await import("../stealth/browser.js");
            const r = await renderPage(cached.url);
            html = r.html;
            status = r.status;
            this.lastRawBytes = html.length;
            if (status !== null && status >= 400) throw new Error(`Etsy product page returned HTTP ${status} for ${cached.listingId} (stealth).`);
          } catch {
            throw new Error(`Etsy product page returned HTTP ${res.status} for ${cached.listingId}.`);
          }
        } else {
          throw new Error(`Etsy product page returned HTTP ${res.status} for ${cached.listingId}.`);
        }
      } else {
        status = res.status;
      }
    }

    assertPageUsable(html, DETAIL_PAGE);
    const $ = cheerio.load(html);

    const titleRaw =
      $('h1[data-buy-box-listing-title]').first().text().trim() ||
      $('h1.wt-text-body-03').first().text().trim() ||
      $('h1').first().text().trim() ||
      cached.name;
    const name = sanitiseProductName(titleRaw).text;

    const priceText =
      $('[data-test-id="price"] .currency-value').first().parent().text().trim() ||
      $('.wt-text-title-03 .currency-value').first().parent().text().trim() ||
      $('[data-buy-box-region] .currency-value').first().parent().text().trim() ||
      $('.wt-text-title-03').first().text().trim() ||
      $('p.wt-text-title-03').first().text().trim() ||
      "";

    const price = parsePrice(priceText);
    if (!price) throw new Error(`Etsy product page for ${cached.listingId} had no readable price.`);

    const detail: ProductDetail = {
      id,
      name,
      price: { value: price.value, currency: price.currency },
      source: this.manifest.domain!,
      mode: "native",
    };
    const image = $('img[data-src*="etsystatic"], img[src*="etsystatic"]').first().attr('src') ?? $('img').first().attr('src');
    if (image) detail.image = image;
    detail.url = cached.url;
    detail.attrs = { cat: inferCategory(name) } as Product["attrs"];

    if (include.includes("description")) {
      const desc =
        $('p[data-product-details-description-text]').first().text().trim() ||
        $('[data-appears-component-name="listing-page-description-text"]').first().text().trim() ||
        "";
      if (desc) detail.description = sanitiseText(desc, { maxLength: 2000 }).text;
    }
    if (include.includes("stock")) detail.stock = html.toLowerCase().includes("out of stock") ? "out_of_stock" : "in_stock";
    if (include.includes("reviews")) {
      const reviews: Array<{ score?: number; text: string }> = [];
      $('[data-review]').slice(0, 3).each((_i, el) => {
        const text = $(el).text().trim();
        if (text) reviews.push({ text: sanitiseText(text, { maxLength: 200 }).text });
      });
      if (reviews.length) detail.reviews = reviews;
    }

    detail._meta = { provenance: PROVENANCE_NOTE };
    return detail;
  }
}
