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
import { renderPage, type RenderResult } from "../stealth/browser.js";
import type { AdapterCtx, StoreAdapter } from "../types.js";

/**
 * Real Target, S16.
 *
 * The uncomfortable truth this file has to be honest about: `mode: "native"`
 * here does NOT mean a JSON API like Tesco's. Target's search results page
 * embeds no product data in `__NEXT_DATA__` (verified live -- every
 * dehydrated query on the page was inspected; none carry a `tcin`-keyed
 * object) and exposes no discoverable client-side fetch for the listing
 * either. What this adapter actually does is drive a real, patched Chromium
 * (`renderPage`, stealth/browser.ts) at Target's own live page and scrape the
 * rendered DOM -- the same page a real signed-out shopper's browser paints.
 * It earns "native" on the same basis as any scrape: it is Target's own data,
 * not a simulation, just fetched by rendering instead of by calling an API.
 *
 * The fragility is real, not theoretical. Target sits behind Akamai-class bot
 * protection: secondary XHRs (`nearby_stores_v1`, `store_location_v1`) came
 * back 403 even on runs where the main page rendered fine, and a
 * `redsky.target.com/captcha` endpoint was observed firing. The product grid
 * itself is virtualized -- wrapper `<div>`s for every card are present
 * immediately, but their title/price children hydrate inconsistently: one
 * probe run found 30 fully-populated cards, the very next found the same
 * selector returning zero populated cards, with no code or timing change.
 * Costco (same protection class, investigated earlier this project) was never
 * bypassable at all; Target sits one notch better -- bypassable, but flaky --
 * which is why search()/detail() below retry a few renders before giving up,
 * and throw an honest "blocked" error rather than ever returning an empty or
 * partial result as if it were success.
 */

const SEARCH_ATTEMPTS = 3;
const DETAIL_ATTEMPTS = 3;
const SETTLE_MS_BY_ATTEMPT = [4000, 8000, 12000];

const CARD_WRAPPER_SELECTOR = '[data-test="@web/site-top-of-funnel/ProductCardWrapper"]';
const CARD_TITLE_SELECTOR = '[data-test="@web/ProductCard/title"]';
const CARD_PRICE_SELECTOR = '[data-test="current-price"], [data-test="@web/Price/PriceStandard"]';

const BLOCK_PATTERNS = [/access denied/i, /robot or human/i, /are you a human/i, /captcha/i];
const MIN_PLAUSIBLE_HTML_LENGTH = 20000;

interface ParsedCard {
  tcin: string;
  path: string;
  name: string;
  price: number;
  image?: string;
}

/** Cached so detail() can resolve a Basketed id back to Target's own TCIN + page path. */
interface Cached {
  tcin: string;
  path: string;
  name: string;
}

export class TargetAdapter implements StoreAdapter {
  readonly manifest: StoreManifest;
  readonly #cache = new Map<string, Cached>();
  readonly #render: typeof renderPage;
  lastRawBytes = 0;

  /**
   * `render` is this adapter's test seam, standing in for `ctx.http`. There is
   * no HTTP call here for ctx.http to authenticate or intercept -- Target's
   * search/detail pages are public and unauthenticated, and the only network
   * primitive that can actually retrieve them is a rendered browser, not a
   * fetch. Tests inject a fake `render` returning fixture HTML; production
   * code defaults to the real stealth-browser renderer.
   */
  constructor(opts: { render?: typeof renderPage } = {}) {
    this.#render = opts.render ?? renderPage;
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

  async search(q: SearchQuery, _ctx: AdapterCtx): Promise<Product[]> {
    this.lastRawBytes = 0;
    const count = Math.min(q.maxResults ?? 10, 50);
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

  async detail(id: string, include: Include[], _ctx: AdapterCtx): Promise<ProductDetail> {
    this.lastRawBytes = 0;
    const cached = this.#cache.get(id);
    if (!cached) {
      throw new Error("Unknown product id for Target. Ids are server-minted; search first, then request detail.");
    }

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

  async #renderTracked(url: string, opts: { settleMs?: number }): Promise<RenderResult> {
    const result = await this.#render(url, opts);
    this.lastRawBytes += result.html.length;
    return result;
  }

  #detectBlock(result: RenderResult): string | null {
    if (result.status !== null && result.status >= 400) return `HTTP ${result.status}`;
    if (result.html.length < MIN_PLAUSIBLE_HTML_LENGTH) return `suspiciously short response (${result.html.length} bytes)`;
    for (const pattern of BLOCK_PATTERNS) {
      if (pattern.test(result.html)) return `page matched block pattern ${pattern}`;
    }
    return null;
  }

  /**
   * Cards on the search page carry two different numbers: `data-focusid`
   * (a virtualization/layout id) and the TCIN embedded in the card's own link
   * href (`/p/<slug>/-/A-<TCIN>`). They are NOT the same value -- confirmed
   * live, e.g. one card had focusId 1012908942 but href TCIN 1012910804.
   * The href's TCIN is Target's real product identifier and the one this
   * adapter mints ids from; focusId is ignored entirely.
   */
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

    let priceText = $('[data-test="product-price"], [data-test="@web/Price/PriceFull"], [data-test="current-price"]')
      .first()
      .text()
      .trim();
    if (!priceText) {
      // Fallback: any data-test attribute whose name mentions "price" and has text,
      // mirroring what live probing found -- Target does not use one stable
      // selector for the PDP price across product types.
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

  /**
   * Target renders ranges and sale prices concatenated with no separator,
   * e.g. "$139.99 - $149.99reg $199.99Sale" or "$89.99reg $179.99Sale". The
   * first dollar amount is always the current (lowest, if ranged) selling
   * price -- verified across every live sample gathered during probing.
   */
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
