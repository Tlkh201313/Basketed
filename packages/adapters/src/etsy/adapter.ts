import * as cheerio from "cheerio";
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
import { renderPage, type RenderResult } from "../stealth/browser.js";
import type { AdapterCtx, StoreAdapter } from "../types.js";

/**
 * Real Etsy, S21.
 *
 * Etsy has no public product search API reachable without an OAuth app
 * (their open API is seller-scoped). What IS reachable is what a signed-out
 * shopper sees: etsy.com/search and etsy.com/listing/<id>, rendered in a
 * patched Chromium (stealth/browser.ts) and parsed with cheerio.
 *
 * Still `mode: "native"` — whose data it is, not how it was fetched.
 * No login, no session, no cart (Etsy cart needs a signed-in session).
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
  readonly #cache = new Map<string, Cached>();
  readonly #render: (url: string) => Promise<RenderResult>;
  lastRawBytes = 0;

  constructor(opts: EtsyAdapterOptions = {}) {
    this.#render = opts.render ?? renderPage;
    this.manifest = {
      id: "etsy:etsy",
      name: "Etsy",
      country: "US",
      currency: "USD",
      language: "en",
      categories: ["general", "apparel", "furniture"],
      mode: "native",
      auth: "none",
      capabilities: ["discovery", "detail"],
      domain: "etsy.com",
    };
  }

  async search(q: SearchQuery, _ctx: AdapterCtx): Promise<Product[]> {
    this.lastRawBytes = 0;
    const count = Math.min(q.maxResults ?? 10, 50);
    const url = `${SEARCH_BASE}?${new URLSearchParams({ q: q.query })}`;
    const { status, html } = await this.#render(url);
    this.lastRawBytes = html.length;
    if (status !== null && status >= 400) throw new Error(`Etsy search returned HTTP ${status}.`);

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

  async detail(id: string, include: Include[], _ctx: AdapterCtx): Promise<ProductDetail> {
    const cached = this.#cache.get(id);
    if (!cached) throw new Error("Unknown product id for Etsy. Ids are server-minted; search first, then request detail.");
    if (!cached.url) throw new Error(`Etsy product ${cached.listingId} has no link to fetch.`);

    this.lastRawBytes = 0;
    const { status, html } = await this.#render(cached.url);
    this.lastRawBytes = html.length;
    if (status !== null && status >= 400) throw new Error(`Etsy product page returned HTTP ${status} for ${cached.listingId}.`);

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
