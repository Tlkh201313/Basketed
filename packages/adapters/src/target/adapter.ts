import { load } from "cheerio";
import {
  fromMinor,
  inferCategory,
  sanitiseProductName,
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
 * Real Target — plain HTTP via redsky JSON, no browser.
 *
 * Previously rendered target.com/s with stealth Chromium because the HTML
 * grid is virtualized and hydrates inconsistently. S22 switches to the same
 * JSON the frontend calls: redsky.target.com/redsky_aggregations/v1/web
 * — plain HTTP, no anti-bot bypass, same live product data.
 *
 * Still `mode: "native"` — Target's own data. render stays as a test seam
 * for the HTML fixtures (so existing tests keep passing); live uses JSON.
 */

const SEARCH_ATTEMPTS = 3;
const DETAIL_ATTEMPTS = 3;
const SETTLE_MS_BY_ATTEMPT = [4000, 8000, 12000];

const CARD_WRAPPER_SELECTOR = '[data-test="@web/site-top-of-funnel/ProductCardWrapper"]';
const CARD_TITLE_SELECTOR = '[data-test="@web/ProductCard/title"]';
const CARD_PRICE_SELECTOR = '[data-test="current-price"], [data-test="@web/Price/PriceStandard"]';

const BLOCK_PATTERNS = [/access denied/i, /robot or human/i, /are you a human/i, /captcha/i];
const MIN_PLAUSIBLE_HTML_LENGTH = 20000;

const REDSKY_KEY = "9f36aeafbe60771e321a7cc95a78140772ab99e1";
const REDSKY_SEARCH_BASE = "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2";
const REDSKY_PDP_BASE = "https://redsky.target.com/redsky_aggregations/v1/web/plp_pdp_v2";

interface ParsedCard {
  tcin: string;
  path: string;
  name: string;
  price: number;
  image?: string;
}

interface Cached {
  tcin: string;
  path: string;
  name: string;
}

export class TargetAdapter implements StoreAdapter {
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
  readonly #render?: typeof import("../stealth/browser.js").renderPage;
  lastRawBytes = 0;

  constructor(opts: { render?: typeof import("../stealth/browser.js").renderPage } = {}) {
    this.#render = opts.render;
    this.manifest = {
      id: "tgt:target",
      name: "Target",
      country: "US",
      currency: "USD",
      language: "en",
      categories: ["general"],
      mode: "native",
      auth: "none",
      capabilities: ["discovery", "detail"],
      domain: "target.com",
    };
  }

  async search(q: SearchQuery, ctx: AdapterCtx): Promise<Product[]> {
    this.lastRawBytes = 0;
    const count = Math.min(q.maxResults ?? 10, 50);

    // Test path: injected render with HTML fixtures
    if (this.#render) {
      const url = `https://www.target.com/s?${new URLSearchParams({ searchTerm: q.query })}`;
      let cards: ParsedCard[] | null = null;
      let lastBlockReason: string | null = null;
      for (let attempt = 0; attempt < SEARCH_ATTEMPTS; attempt++) {
        const result = await this.#renderTracked(url, { settleMs: SETTLE_MS_BY_ATTEMPT[attempt] });
        const block = this.#detectBlock(result);
        if (block) {
          lastBlockReason = block;
          continue;
        }
        const parsed = this.#parseSearchHtml(result.html);
        if (parsed.length > 0) {
          cards = parsed;
          break;
        }
        lastBlockReason = "the search page rendered but no product cards hydrated";
      }
      if (!cards) {
        throw new Error(
          `Target search appears blocked or did not render results after ${SEARCH_ATTEMPTS} attempts ` +
            `(${lastBlockReason ?? "unknown reason"}). This is Target's Akamai-class bot protection, not a ` +
            "code bug -- refusing to fabricate a result.",
        );
      }
      return cards.slice(0, count).map((c) => this.#toProduct(c));
    }

    // Live path: plain HTML via ctx.http — no browser (redsky JSON now captchas, but HTML with proper headers returns 200)
    const url = `https://www.target.com/s?${new URLSearchParams({ searchTerm: q.query })}`;
    const res = await ctx.http(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.google.com/",
      },
    });
    const html = await res.text();
    this.lastRawBytes = html.length;
    if (!res.ok) throw new Error(`Target search returned HTTP ${res.status}.`);
    const parsed = this.#parseSearchHtml(html);
    if (!parsed.length) return [];
    return parsed.slice(0, count).map((c) => this.#toProduct(c));
  }

  async detail(id: string, include: Include[], ctx: AdapterCtx): Promise<ProductDetail> {
    const cached = this.#cache.get(id);
    if (!cached) {
      throw new Error("Unknown product id for Target. Ids are server-minted; search first, then request detail.");
    }
    this.lastRawBytes = 0;

    if (this.#render) {
      const url = `https://www.target.com${cached.path}`;
      let parsed: { name: string; price: number; image?: string } | null = null;
      let lastBlockReason: string | null = null;
      for (let attempt = 0; attempt < DETAIL_ATTEMPTS; attempt++) {
        const result = await this.#renderTracked(url, { settleMs: SETTLE_MS_BY_ATTEMPT[attempt] });
        const block = this.#detectBlock(result);
        if (block) {
          lastBlockReason = block;
          continue;
        }
        const found = this.#parseDetailHtml(result.html);
        if (found) {
          parsed = found;
          break;
        }
        lastBlockReason = "the product page rendered but title/price never hydrated";
      }
      if (!parsed) {
        throw new Error(
          `Target product page for ${cached.tcin} appears blocked or did not render after ${DETAIL_ATTEMPTS} ` +
            `attempts (${lastBlockReason ?? "unknown reason"}). Refusing to fabricate a result.`,
        );
      }
      const name = sanitiseProductName(parsed.name || cached.name).text;
      const detail: ProductDetail = {
        id,
        name,
        price: fromMinor(Math.round(parsed.price * 100), this.manifest.currency),
        source: this.manifest.domain!,
        mode: "native",
      };
      if (parsed.image) detail.image = parsed.image;
      const attrs: Record<string, unknown> = { cat: inferCategory(name) };
      detail.attrs = attrs as Product["attrs"];
      if (include.includes("stock")) detail.stock = "in_stock";
      detail._meta = { provenance: PROVENANCE_NOTE };
      return detail;
    }

    // Live path: plain HTML PDP via ctx.http
    const url = `https://www.target.com${cached.path}`;
    const res = await ctx.http(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.google.com/",
      },
    });
    const html = await res.text();
    this.lastRawBytes = html.length;
    if (!res.ok) throw new Error(`Target product page returned HTTP ${res.status} for ${cached.tcin}.`);
    const parsed = this.#parseDetailHtml(html);
    if (!parsed) throw new Error(`Target product page for ${cached.tcin} had no readable price.`);
    const name = sanitiseProductName(parsed.name || cached.name).text;
    const detail: ProductDetail = {
      id,
      name,
      price: fromMinor(Math.round(parsed.price * 100), this.manifest.currency),
      source: this.manifest.domain!,
      mode: "native",
    };
    if (parsed.image) detail.image = parsed.image;
    const attrs: Record<string, unknown> = { cat: inferCategory(name) };
    detail.attrs = attrs as Product["attrs"];
    if (include.includes("stock")) detail.stock = "in_stock";
    detail._meta = { provenance: PROVENANCE_NOTE };
    return detail;
  }

  async #renderTracked(url: string, opts: { settleMs?: number }): Promise<import("../stealth/browser.js").RenderResult> {
    const result = await this.#render!(url, opts);
    this.lastRawBytes += result.html.length;
    return result;
  }

  #detectBlock(result: import("../stealth/browser.js").RenderResult): string | null {
    if (result.status !== null && result.status >= 400) return `HTTP ${result.status}`;
    if (result.html.length < MIN_PLAUSIBLE_HTML_LENGTH) return `suspiciously short response (${result.html.length} bytes)`;
    for (const pattern of BLOCK_PATTERNS) {
      if (pattern.test(result.html)) return `page matched block pattern ${pattern}`;
    }
    return null;
  }

  #parseSearchHtml(html: string): ParsedCard[] {
    const $ = load(html);
    const cards: ParsedCard[] = [];
    $(CARD_WRAPPER_SELECTOR).each((_i, el) => {
      const $el = $(el);
      const href = $el.find('a[href*="/p/"]').first().attr("href");
      const name = $el.find(CARD_TITLE_SELECTOR).first().text().trim();
      const priceText = $el.find(CARD_PRICE_SELECTOR).first().text().trim();
      if (!href || !name || !priceText) return;
      const match = /\/p\/([^/?#]+)\/-\/A-(\d+)/.exec(href);
      if (!match) return;
      const [, slug, tcin] = match;
      const price = this.#extractLowPrice(priceText);
      if (price === null) return;
      const image = $el.find("img").first().attr("src") ?? undefined;
      cards.push({ tcin: tcin!, path: `/p/${slug}/-/A-${tcin}`, name, price, image });
    });
    return cards;
  }

  #parseDetailHtml(html: string): { name: string; price: number; image?: string } | null {
    const $ = load(html);
    const name = $('[data-test="product-title"], h1[data-test], h1').first().text().trim();
    let priceText = $('[data-test="product-price"], [data-test="@web/Price/PriceFull"], [data-test="current-price"]').first().text().trim();
    if (!priceText) {
      $("[data-test]").each((_i, el) => {
        if (priceText) return;
        const attr = $(el).attr("data-test") ?? "";
        if (/price/i.test(attr)) {
          const text = $(el).text().trim();
          if (text) priceText = text;
        }
      });
    }
    if (!name || !priceText) return null;
    const price = this.#extractLowPrice(priceText);
    if (price === null) return null;
    const image = $('[data-test="hero-image"] img, picture img').first().attr("src") ?? undefined;
    return { name, price, image };
  }

  #parseRedskySearch(data: Record<string, unknown>): ParsedCard[] {
    // redsky shape: data.search.searchResult.itemStacks[0].items or data.search.products
    const search = (data?.data as Record<string, unknown>)?.search as Record<string, unknown> | undefined;
    // Try multiple shapes observed live
    const searchResult = (search?.searchResult as Record<string, unknown>) ?? search;
    const itemStacks = (searchResult?.itemStacks as Array<Record<string, unknown>>) ?? (searchResult?.itemStack as Array<Record<string, unknown>>) ?? [];
    // Flat products list
    const productsRaw: unknown[] =
      (searchResult?.products as unknown[]) ??
      (search?.products as unknown[]) ??
      (data?.data as Record<string, unknown>)?.products as unknown[] ??
      [];
    if (Array.isArray(productsRaw) && productsRaw.length) {
      return this.#mapRedskyProducts(productsRaw as Array<Record<string, unknown>>);
    }
    if (itemStacks.length) {
      const items: unknown[] = [];
      for (const stack of itemStacks) {
        const stackItems = (stack?.items as unknown[]) ?? (stack?.slots as unknown[]) ?? [];
        items.push(...stackItems);
      }
      if (items.length) return this.#mapRedskyProducts(items as Array<Record<string, unknown>>);
      // Some shapes have itemStack[0].items[0].item
      const firstStackItems = (itemStacks[0] as Record<string, unknown>)?.items as unknown[];
      if (Array.isArray(firstStackItems)) return this.#mapRedskyProducts(firstStackItems as Array<Record<string, unknown>>);
    }
    // Last fallback: data.search.search_response
    const searchResp = (search?.search_response as Record<string, unknown>) ?? {};
    const typedItems = (searchResp?.items as Record<string, unknown>)?.Item as unknown[];
    if (Array.isArray(typedItems)) return this.#mapRedskyProducts(typedItems as Array<Record<string, unknown>>);
    return [];
  }

  #mapRedskyProducts(raw: Array<Record<string, unknown>>): ParsedCard[] {
    const out: ParsedCard[] = [];
    for (const entry of raw) {
      const item = (entry?.item as Record<string, unknown>) ?? entry;
      const prod = (item?.product as Record<string, unknown>) ?? item;
      const tcin = (item?.tcin as string) ?? (prod?.tcin as string) ?? (entry?.tcin as string) ?? "";
      if (!tcin) continue;
      const desc = (item?.product_description as Record<string, unknown>) ?? (prod?.product_description as Record<string, unknown>) ?? {};
      const title = (desc?.title as string) ?? (item?.title as string) ?? (prod?.title as string) ?? "";
      if (!title) continue;
      // price: price.current_retail or price.formatted_current_price or item.enrichment.buyBoxPrice
      const priceObj = (item?.price as Record<string, unknown>) ?? (prod?.price as Record<string, unknown>) ?? {};
      const current = priceObj?.current_retail as number | undefined;
      const formatted = priceObj?.formatted_current_price as string | undefined;
      let price: number | null = null;
      if (typeof current === "number") price = current;
      else if (formatted) {
        const m = /\$([\d,]+\.\d{2})/.exec(formatted);
        if (m) price = Number(m[1]!.replace(/,/g, ""));
      }
      if (price === null) {
        const priceText = (priceObj?.currentRetail as string) ?? "";
        price = this.#extractLowPrice(priceText);
      }
      if (price === null || !Number.isFinite(price)) continue;
      const images = (item?.enrichment as Record<string, unknown>)?.images as Array<Record<string, unknown>> | undefined;
      const primary = images?.[0]?.base_url as string | undefined;
      const img = primary ? `${primary}` : (item?.images as Array<Record<string, unknown>>)?.[0]?.base_url as string | undefined;
      // Path for PDP
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      out.push({ tcin, path: `/p/${slug}/-/A-${tcin}`, name: title, price, image: img });
    }
    return out;
  }

  #parseRedskyPdp(data: Record<string, unknown>, cached: Cached): { name: string; price: number; image?: string } | null {
    const prodData = (data?.data as Record<string, unknown>)?.product as Record<string, unknown> | undefined;
    const product = prodData ?? (data?.product as Record<string, unknown>) ?? (data?.data as Record<string, unknown>);
    if (!product) return null;
    // redsky PDP shape: data.product.item.product_description.title + price
    const item = (product?.item as Record<string, unknown>) ?? product;
    const desc = (item?.product_description as Record<string, unknown>) ?? (item as Record<string, unknown>);
    const title = (desc?.title as string) ?? (item?.title as string) ?? cached.name;
    const priceObj = (item?.price as Record<string, unknown>) ?? {};
    const current = priceObj?.current_retail as number | undefined;
    let price: number | null = null;
    if (typeof current === "number") price = current;
    else {
      const formatted = priceObj?.formatted_current_price as string | undefined;
      if (formatted) {
        const m = /\$([\d,]+\.\d{2})/.exec(formatted);
        if (m) price = Number(m[1]!.replace(/,/g, ""));
      }
    }
    if (price === null) {
      const priceText = (priceObj?.currentRetail as string) ?? "";
      price = this.#extractLowPrice(priceText);
    }
    if (price === null) return null;
    const images = (item?.enrichment as Record<string, unknown>)?.images as Array<Record<string, unknown>> | undefined;
    const img = images?.[0]?.base_url as string | undefined;
    return { name: title, price, image: img };
  }

  #extractLowPrice(priceText: string): number | null {
    const match = /\$([\d,]+\.\d{2})/.exec(priceText);
    if (!match) return null;
    return Number(match[1]!.replace(/,/g, ""));
  }

  #toProduct(card: ParsedCard): Product {
    const name = sanitiseProductName(card.name).text;
    const id = mintProductId(this.manifest.id, card.tcin);
    this.#cache.set(id, { tcin: card.tcin, path: card.path, name });
    const product: Product = {
      id,
      name,
      price: fromMinor(Math.round(card.price * 100), this.manifest.currency),
      source: this.manifest.domain!,
      mode: "native",
    };
    if (card.image) product.image = card.image;
    const attrs: Record<string, unknown> = { cat: inferCategory(name) };
    product.attrs = attrs as Product["attrs"];
    return product;
  }
}
