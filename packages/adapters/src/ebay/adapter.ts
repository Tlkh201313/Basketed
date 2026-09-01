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
import type { RenderResult } from "../stealth/browser.js";
import type { AdapterCtx, StoreAdapter } from "../types.js";
import { IdCache } from "../id-cache.js";

/**
 * Real eBay — plain HTTP, no browser.
 *
 * ebay.com/sch and /itm are SSR HTML reachable via plain HTTP. S22 switches
 * from stealth render to ctx.http so all 24 stores work without Chromium.
 * Cart remains local (no retailer API) → handoff https://cart.ebay.com.
 * `render` stays as test seam for canned HTML.
 */

const SEARCH_BASE = "https://www.ebay.com/sch/i.html";
const ITEM_BASE = "https://www.ebay.com/itm/";

const CURRENCY_SYMBOLS: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR", "¥": "JPY", "C $": "CAD", "AU $": "AUD" };

function parsePrice(text: string): { value: number; currency: string } | null {
  const trimmed = text.trim();
  // "$139.99" / "£24.50" / "EUR 19.99" / "US $24.99"
  const symbolMatch = /(?:US\s*)?([$£€¥])\s*([\d,]+\.?\d*)/.exec(trimmed);
  if (symbolMatch) {
    const sym = symbolMatch[1]!;
    const currency = CURRENCY_SYMBOLS[sym] ?? "USD";
    const value = Number(symbolMatch[2]!.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) return { value, currency };
  }
  const codeMatch = /^([A-Z]{3})\s*([\d,]+\.?\d*)$/.exec(trimmed);
  if (codeMatch) {
    const value = Number(codeMatch[2]!.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) return { value, currency: codeMatch[1]! };
  }
  // eBay often shows " $ 24.50 " inside .s-item__price or .x-price-primary > .ux-textspans
  const loose = /\$\s*([\d,]+\.\d{2})/.exec(trimmed);
  if (loose) {
    const value = Number(loose[1]!.replace(/,/g, ""));
    if (Number.isFinite(value)) return { value, currency: "USD" };
  }
  return null;
}

function itemIdFromHref(href: string): string | null {
  // /itm/123456789012  or /itm/Title-123456789012?hash...
  const m = /\/itm\/(?:[^/?#]*-)?(\d{9,12})/.exec(href);
  if (m) return m[1]!;
  const m2 = /\/itm\/(\d{9,12})/.exec(href);
  if (m2) return m2[1]!;
  return null;
}

interface Cached {
  itemId: string;
  url: string;
  name: string;
  price: { value: number; currency: string };
}

export interface EbayAdapterOptions {
  render?: (url: string) => Promise<RenderResult>;
}

export class EbayAdapter implements StoreAdapter {
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

  constructor(opts: EbayAdapterOptions = {}) {
    this.#render = opts.render;
    this.manifest = {
      id: "ebay:ebay",
      name: "eBay",
      country: "US",
      currency: "USD",
      language: "en",
      categories: ["general", "electronics", "apparel"],
      mode: "native",
      auth: "none",
      capabilities: ["discovery", "detail", "cart", "handoff"],
      domain: "ebay.com",
    };
  }

  async search(q: SearchQuery, ctx: AdapterCtx): Promise<Product[]> {
    this.lastRawBytes = 0;
    const count = Math.min(q.maxResults ?? 10, 50);
    const url = `${SEARCH_BASE}?${new URLSearchParams({ _nkw: q.query })}`;
    let html: string;
    let status: number | null = 200;
    if (this.#render) {
      const res = await this.#render(url);
      html = res.html;
      status = res.status;
      this.lastRawBytes = html.length;
      if (status !== null && status >= 400) throw new Error(`eBay search returned HTTP ${status}.`);
    } else {
      const res = await ctx.http(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15A372 Safari/604.1",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      html = await res.text();
      this.lastRawBytes = html.length;
      if (!res.ok) throw new Error(`eBay search returned HTTP ${res.status}.`);
      status = res.status;
    }

    const $ = cheerio.load(html);
    const products: Product[] = [];

    const cards = $('li.s-item, li.s-item--large, div.s-item__wrapper').toArray();
    for (const el of cards) {
      if (products.length >= count) break;
      const card = $(el);
      const link = card.find('a.s-item__link').first().attr('href') ?? card.find('a[href*="/itm/"]').first().attr('href') ?? "";
      if (!link) continue;
      const itemId = itemIdFromHref(link);
      if (!itemId) continue;
      const absoluteUrl = new URL(link, "https://www.ebay.com").toString();

      const titleRaw =
        card.find('div.s-item__title').first().text().trim() ||
        card.find('h3.s-item__title').first().text().trim() ||
        card.find('a.s-item__link').first().text().trim() ||
        "";
      // eBay injects "Shop on eBay" placeholder as first s-item; skip it
      if (!titleRaw || /shop on ebay/i.test(titleRaw)) continue;

      const priceText =
        card.find('span.s-item__price').first().text().trim() ||
        card.find('.s-item__detail--primary .s-item__price').first().text().trim() ||
        card.text();
      const price = parsePrice(priceText);
      if (!price) continue;

      const name = sanitiseProductName(titleRaw).text;
      const id = mintProductId(this.manifest.id, itemId);
      this.#cache.set(id, { itemId, url: absoluteUrl, name, price });

      const image = card.find('img.s-item__image-img').first().attr('src') ?? card.find('img').first().attr('src') ?? undefined;

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

      // Optional rating if present (eBay feedback)
      const ratingText = card.find('.x-star-rating').first().text().trim();
      const ratingMatch = /([\d.]+)\s*out of 5/i.exec(ratingText);
      if (ratingMatch) {
        const score = Number(ratingMatch[1]);
        if (Number.isFinite(score)) product.rating = { score, count: 0 };
      }

      products.push(product);
    }
    return products;
  }

  async detail(id: string, include: Include[], ctx: AdapterCtx): Promise<ProductDetail> {
    const cached = this.#cache.get(id);
    if (!cached) throw new Error("Unknown product id for eBay. Ids are server-minted; search first, then request detail.");
    if (!cached.url) throw new Error(`eBay product ${cached.itemId} has no link to fetch.`);

    this.lastRawBytes = 0;
    let html: string;
    let status: number | null = 200;
    if (this.#render) {
      const res = await this.#render(cached.url);
      html = res.html;
      status = res.status;
      this.lastRawBytes = html.length;
      if (status !== null && status >= 400) throw new Error(`eBay product page returned HTTP ${status} for ${cached.itemId}.`);
    } else {
      const res = await ctx.http(cached.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15A372 Safari/604.1",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      html = await res.text();
      this.lastRawBytes = html.length;
      if (!res.ok) throw new Error(`eBay product page returned HTTP ${res.status} for ${cached.itemId}.`);
      status = res.status;
    }

    const $ = cheerio.load(html);

    const titleRaw =
      $('h1.x-item-title-label').first().text().trim() ||
      $('h1#x-ebay-title').first().text().trim() ||
      $('h1.it-ttl').first().text().trim() ||
      $('h1').first().text().trim() ||
      cached.name;
    const name = sanitiseProductName(titleRaw).text;

    const priceText =
      $('.x-price-primary .ux-textspans').first().text().trim() ||
      $('.x-price-primary').first().text().trim() ||
      $('[data-testid="price"] .ux-textspans').first().text().trim() ||
      $('.notranslate').first().text().trim() ||
      "";

    const price = parsePrice(priceText);
    if (!price) throw new Error(`eBay product page for ${cached.itemId} had no readable price.`);

    const detail: ProductDetail = {
      id,
      name,
      price: { value: price.value, currency: price.currency },
      source: this.manifest.domain!,
      mode: "native",
    };
    const image = $('#x-zoom-container img').first().attr('src') ?? $('img#x-zoom-container').first().attr('src') ?? $('img').first().attr('src');
    if (image) detail.image = image;
    detail.url = cached.url;
    detail.attrs = { cat: inferCategory(name) } as Product["attrs"];

    if (include.includes("description")) {
      const desc = $('#x-desc div').first().text().trim() || $('[data-testid="description"] ').first().text().trim() || "";
      if (desc) detail.description = sanitiseText(desc, { maxLength: 2000 }).text;
    }
    if (include.includes("stock")) detail.stock = html.toLowerCase().includes("out of stock") ? "out_of_stock" : "in_stock";
    detail._meta = { provenance: PROVENANCE_NOTE };
    return detail;
  }

  async buildCart(items: Array<{ id: string; quantity: number }>, _ctx: AdapterCtx): Promise<import("../types.js").RawCart> {
    this.lastRawBytes = 0;
    const lineItems = items.map((i) => {
      const cached = this.#cache.get(i.id);
      if (!cached) throw new Error(`Unknown product id "${i.id}" for eBay.`);
      return {
        id: i.id,
        variantId: cached.itemId,
        quantity: i.quantity,
        name: cached.name,
        unitPrice: { value: cached.price.value, currency: cached.price.currency },
      };
    });
    const currency = lineItems[0]?.unitPrice.currency ?? this.manifest.currency;
    const subtotal = Number(lineItems.reduce((sum, li) => sum + li.unitPrice.value * li.quantity, 0).toFixed(2));
    // Handoff is the shopper's own eBay cart — they complete checkout themselves.
    // No payment is completed by Basketed; outcome is HANDED_OFF/unknown.
    return {
      cartId: `ebay_cart_${Date.now().toString(36)}`,
      lineItems,
      subtotal: { value: subtotal, currency },
      total: { value: subtotal, currency },
      adjustments: [],
      handoffUrl: "https://cart.ebay.com",
    };
  }

  async handoff(cartId: string, _ctx: AdapterCtx): Promise<{ handoffUrl: string }> {
    void cartId;
    return { handoffUrl: "https://cart.ebay.com" };
  }
}
