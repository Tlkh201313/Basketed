import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PROVENANCE_NOTE,
  sanitiseProductName,
  type Category,
  type Include,
  type Product,
  type ProductDetail,
  type SearchQuery,
  type StoreManifest,
} from "@basketed/core";
import { mintProductId } from "../ids.js";
import type { AdapterCtx, CartLineItem, RawCart, StoreAdapter } from "../types.js";

interface SeedProduct {
  store: string;
  nativeId: string;
  name: string;
  price: { value: number; currency: string };
  rating: { score: number; count: number };
  url: string;
  attrs: Record<string, unknown>;
}

interface SeedStore {
  id: string;
  name: string;
  country: string;
  currency: string;
  categories: Category[];
  searchUrl: string;
  note: string;
}

interface SeedFile {
  stores: SeedStore[];
  products: SeedProduct[];
}

/**
 * Fixture-backed adapter for retailers with no lawful automated route
 * (Tesco, Amazon, Costco, Walmart, Shopee, Taobao, IKEA -- §4).
 *
 * It implements the IDENTICAL interface to the real adapters, so the purchase
 * gate, the approval flow, the guardrails and the redaction layer are all
 * exercised exactly as they are for Shopify. Nothing about the safety-critical
 * path is simulated; only the product data is.
 *
 * Deliberately NO `handoff` capability. There is no real checkout URL behind
 * these stores, and returning a search link dressed up as a cart would be the
 * single most misleading thing this product could do. A simulated store
 * completes to a clearly-stamped simulated order instead.
 */
export class SimulatedAdapter implements StoreAdapter {
  readonly manifest: StoreManifest;
  readonly #products: SeedProduct[];
  readonly #cache = new Map<string, SeedProduct>();
  readonly note: string;

  constructor(store: SeedStore, products: SeedProduct[]) {
    this.note = store.note;
    this.#products = products;
    this.manifest = {
      id: store.id,
      name: store.name,
      country: store.country,
      currency: store.currency,
      language: "en",
      categories: store.categories,
      mode: "simulated",
      auth: "simulated",
      capabilities: ["discovery", "detail", "cart"],
    };
  }

  static async loadAll(root = process.cwd()): Promise<SimulatedAdapter[]> {
    const path = resolve(root, "fixtures/simulated/catalog.json");
    const seed = JSON.parse(await readFile(path, "utf8")) as SeedFile;
    return seed.stores.map(
      (s) => new SimulatedAdapter(s, seed.products.filter((p) => p.store === s.id)),
    );
  }

  #toProduct(seed: SeedProduct): Product {
    const id = mintProductId(this.manifest.id, seed.nativeId);
    this.#cache.set(id, seed);
    return {
      id,
      name: sanitiseProductName(seed.name).text,
      price: { value: seed.price.value, currency: seed.price.currency },
      rating: seed.rating,
      source: this.manifest.name,
      // Never omitted, never softened. This is what stops a synthetic price
      // being mistaken for a real one.
      mode: "simulated",
      url: seed.url,
      attrs: seed.attrs as Product["attrs"],
    };
  }

  async search(q: SearchQuery, _ctx: AdapterCtx): Promise<Product[]> {
    const terms = q.query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = this.#products
      .map((p) => {
        const hay = `${p.name} ${JSON.stringify(p.attrs)}`.toLowerCase();
        const score = terms.filter((t) => hay.includes(t)).length;
        return { p, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.p.price.value - b.p.price.value);

    const limited = (scored.length ? scored.map((s) => s.p) : []).slice(0, q.maxResults ?? 8);
    const filtered = q.priceMax ? limited.filter((p) => p.price.value <= q.priceMax!) : limited;
    return filtered.map((p) => this.#toProduct(p));
  }

  async detail(id: string, include: Include[], _ctx: AdapterCtx): Promise<ProductDetail> {
    const seed = this.#cache.get(id);
    if (!seed) throw new Error(`Unknown product id "${id}" for ${this.manifest.id}.`);
    const detail: ProductDetail = { ...this.#toProduct(seed) };
    if (include.includes("description")) {
      detail.description = `${seed.name}. Simulated listing for ${this.manifest.name}. ${this.note}`;
    }
    if (include.includes("stock")) detail.stock = "in_stock";
    if (include.includes("delivery")) detail.delivery = "simulated: 2-4 days";
    detail._meta = { provenance: `SIMULATED. ${PROVENANCE_NOTE}` };
    return detail;
  }

  async buildCart(items: Array<{ id: string; quantity: number }>, _ctx: AdapterCtx): Promise<RawCart> {
    const lineItems: CartLineItem[] = items.map((i) => {
      const seed = this.#cache.get(i.id);
      if (!seed) throw new Error(`Unknown product id "${i.id}" for ${this.manifest.id}.`);
      return {
        id: i.id,
        variantId: seed.nativeId,
        quantity: i.quantity,
        name: sanitiseProductName(seed.name).text,
        unitPrice: { value: seed.price.value, currency: seed.price.currency },
      };
    });

    const currency = lineItems[0]?.unitPrice.currency ?? this.manifest.currency;
    const subtotal = Number(
      lineItems.reduce((sum, li) => sum + li.unitPrice.value * li.quantity, 0).toFixed(2),
    );

    return {
      // The `sim_` prefix survives into logs and the UI, so a simulated cart is
      // identifiable even out of context.
      cartId: `sim_cart_${this.manifest.id.split(":")[1]}_${Date.now().toString(36)}`,
      lineItems,
      subtotal: { value: subtotal, currency },
      total: { value: subtotal, currency },
      adjustments: [],
      // No real checkout exists. Saying so is the whole point.
      handoffUrl: null,
    };
  }
}
