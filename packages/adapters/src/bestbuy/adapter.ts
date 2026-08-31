import { load } from "cheerio";
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
 * Real Best Buy, S21.
 *
 * Best Buy's search (bestbuy.com/site/searchpage.jsp) is SSR HTML for
 * signed-out shoppers. No public JSON API without a partner key. This
 * adapter renders the page in stealth Chromium and parses the DOM.
 *
 * `mode: "native"` — Best Buy's own live data, same as Amazon/Target/eBay/Etsy.
 * No login, no cart (cart would need a signed-in session + anti-bot bypass).
 */

const SEARCH_BASE = "https://www.bestbuy.com/site/searchpage.jsp";

const CURRENCY_SYMBOLS: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR" };

function parsePrice(text: string): { value: number; currency: string } | null {
  const m = /\$\s*([\d,]+\.?\d*)/.exec(text);
  if (m) {
    const value = Number(m[1]!.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) return { value, currency: "USD" };
  }
  const codeMatch = /^([A-Z]{3})\s*([\d,]+\.?\d*)$/.exec(text.trim());
  if (codeMatch) {
    const value = Number(codeMatch[2]!.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) return { value, currency: codeMatch[1]! };
  }
  return null;
}

function skuFromHref(href: string): string | null {
  // /site/product-name/sku-1234567.p or .skuId=1234567
  const m1 = /skuId=(\d{6,8})/.exec(href);
  if (m1) return m1[1]!;
  const m2 = /\.p\?skuId=(\d{6,8})/.exec(href);
  if (m2) return m2[1]!;
  const m3 = /\/sku\/(\d{6,8})/.exec(href);
  if (m3) return m3[1]!;
  // Fallback: extract digits from bestbuy sku href
  const m4 = /(\d{6,8})\.p/.exec(href);
  if (m4) return m4[1]!;
  return null;
}

interface Cached {
  sku: string;
  url: string;
  name: string;
}

export interface BestBuyAdapterOptions {
  render?: (url: string) => Promise<RenderResult>;
}

export class BestBuyAdapter implements StoreAdapter {
  readonly manifest: StoreManifest;
  readonly #cache = new Map<string, Cached>();
  readonly #render: (url: string) => Promise<RenderResult>;
  lastRawBytes = 0;

  constructor(opts: BestBuyAdapterOptions = {}) {
    this.#render = opts.render ?? renderPage;
    this.manifest = {
      id: "bby:bestbuy",
      name: "Best Buy",
      country: "US",
      currency: "USD",
      language: "en",
      categories: ["electronics", "general"],
      mode: "native",
      auth: "none",
      capabilities: ["discovery", "detail"],
      domain: "bestbuy.com",
    };
  }

  async search(q: SearchQuery, _ctx: AdapterCtx): Promise<Product[]> {
    this.lastRawBytes = 0;
    const count = Math.min(q.maxResults ?? 10, 50);
    const url = `${SEARCH_BASE}?${new URLSearchParams({ st: q.query, id: "pcat17071" })}`;
    const { status, html } = await this.#render(url);
    this.lastRawBytes = html.length;
    if (status !== null && status >= 400) throw new Error(`Best Buy search returned HTTP ${status}.`);

    const $ = load(html);
    const products: Product[] = [];

    // Best Buy has used several card markups; try all live-observed variants
    const cardSelectors = [
      'li.sku-item',
      'div.sku-item',
      '[data-testid="product-card"]',
      'ol.sku-item-list li',
    ];
    let cards: ReturnType<typeof $> | null = null;
    for (const sel of cardSelectors) {
      const found = $(sel);
      if (found.length) {
        cards = found;
        break;
      }
    }
    if (!cards || !cards.length) {
      // Fallback: any link to a sku
      cards = $('a[href*="skuId="]');
    }

    cards.each((_i, el) => {
      if (products.length >= count) return;
      const card = $(el);
      // If card is an <a>, treat card itself as link; otherwise find link inside
      const linkEl = card.is('a[href*="skuId="]') ? card : card.find('a[href*="skuId="]').first().length ? card.find('a[href*="skuId="]').first() : card.find('a[href*="/site/"]').first();
      const href = linkEl.attr('href') ?? "";
      if (!href) return;
      const sku = skuFromHref(href);
      if (!sku) return;
      const absoluteUrl = new URL(href, "https://www.bestbuy.com").toString();

      const titleRaw =
        card.find('h4.sku-title a').first().text().trim() ||
        card.find('a[data-testid="product-title"]').first().text().trim() ||
        card.find('.sku-title').first().text().trim() ||
        linkEl.text().trim() ||
        "";
      if (!titleRaw) return;

      const priceText =
        card.find('.pricing-price__range').first().text().trim() ||
        card.find('[data-testid="customer-price"]').first().text().trim() ||
        card.find('.priceView-customer-price span').first().text().trim() ||
        card.find('.sr-only').first().text().trim() ||
        card.text();
      const price = parsePrice(priceText);
      if (!price) return;

      const name = sanitiseProductName(titleRaw).text;
      const id = mintProductId(this.manifest.id, sku);
      this.#cache.set(id, { sku, url: absoluteUrl, name });

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

      // Rating: Best Buy shows "4.6 out of 5" in sr-only or data-testid
      const ratingText = card.find('.c-ratings-reviews').first().text().trim() || card.find('[data-testid="customer-rating"]').first().text().trim();
      const ratingMatch = /([\d.]+)\s*out of 5/i.exec(ratingText);
      if (ratingMatch) {
        const score = Number(ratingMatch[1]);
        if (Number.isFinite(score)) product.rating = { score, count: 0 };
      }

      products.push(product);
    });

    return products;
  }

  async detail(id: string, include: Include[], _ctx: AdapterCtx): Promise<ProductDetail> {
    const cached = this.#cache.get(id);
    if (!cached) throw new Error("Unknown product id for Best Buy. Ids are server-minted; search first, then request detail.");
    if (!cached.url) throw new Error(`Best Buy product ${cached.sku} has no link to fetch.`);

    this.lastRawBytes = 0;
    const { status, html } = await this.#render(cached.url);
    this.lastRawBytes = html.length;
    if (status !== null && status >= 400) throw new Error(`Best Buy product page returned HTTP ${status} for ${cached.sku}.`);

    const $ = load(html);

    const titleRaw =
      $('h1').first().text().trim() ||
      $('[data-testid="product-title"]').first().text().trim() ||
      $('.sku-title h1').first().text().trim() ||
      cached.name;
    const name = sanitiseProductName(titleRaw).text;

    const priceText =
      $('[data-testid="customer-price"] span').first().text().trim() ||
      $('.priceView-customer-price span').first().text().trim() ||
      $('.pricing-price__value').first().text().trim() ||
      "";

    const price = parsePrice(priceText);
    if (!price) throw new Error(`Best Buy product page for ${cached.sku} had no readable price.`);

    const detail: ProductDetail = {
      id,
      name,
      price: { value: price.value, currency: price.currency },
      source: this.manifest.domain!,
      mode: "native",
    };
    const image = $('img.primary-image').first().attr('src') ?? $('.shop-media-gallery img').first().attr('src') ?? $('img').first().attr('src');
    if (image) detail.image = image;
    detail.url = cached.url;
    detail.attrs = { cat: inferCategory(name) } as Product["attrs"];

    if (include.includes("description")) {
      const desc = $('div[data-testid="product-description"] p').first().text().trim() || $('.product-description').first().text().trim() || "";
      if (desc) detail.description = sanitiseText(desc, { maxLength: 2000 }).text;
    }
    if (include.includes("stock")) detail.stock = html.toLowerCase().includes("sold out") ? "out_of_stock" : "in_stock";
    detail._meta = { provenance: PROVENANCE_NOTE };
    return detail;
  }
}
