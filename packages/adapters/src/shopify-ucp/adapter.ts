import {
  fromMinor,
  inferCategory,
  sanitiseProductName,
  sanitiseText,
  PROVENANCE_NOTE,
  type Include,
  type Money,
  type Product,
  type ProductDetail,
  type SearchQuery,
  type StoreManifest,
} from "@basketed/core";
import { mintProductId } from "../ids.js";
import type { AdapterCtx, CartLineItem, RawCart, StoreAdapter } from "../types.js";
import { UcpClient, resolveHandoffUrl } from "./client.js";

/* ------------------------------------------------- upstream response shapes */

interface UcpMoney {
  amount: number;
  currency: string;
}

interface UcpVariant {
  id: string;
  sku?: string;
  title?: string;
  price?: UcpMoney;
  availability?: { available?: boolean };
  options?: Array<{ name: string; label: string }>;
  media?: Array<{ type: string; url: string }>;
}

interface UcpProduct {
  id: string;
  title?: string;
  description?: { html?: string };
  url?: string;
  handle?: string;
  price_range?: { min?: UcpMoney; max?: UcpMoney };
  variants?: UcpVariant[];
  media?: Array<{ type: string; url: string }>;
  categories?: string[];
  tags?: string[];
  options?: Array<{ name: string; values?: string[] }>;
}

interface UcpSearchPayload {
  products?: UcpProduct[];
  pagination?: { has_next_page?: boolean; cursor?: string };
  messages?: unknown[];
}

interface UcpCartPayload {
  id?: string;
  currency?: string;
  line_items?: Array<{
    id?: string;
    quantity?: number;
    /** `price` here is a bare integer in minor units, not a UcpMoney. */
    item?: { id?: string; title?: string; price?: number };
    title?: string;
    unit_price?: UcpMoney;
    total?: UcpMoney;
  }>;
  totals?: Array<{ type: string; amount: number; display_text?: string }>;
  expires_at?: string;
  continue_url?: string;
}

/** What we remember about a product so a later cart or detail call can resolve it. */
interface Cached {
  nativeProductId: string;
  variantId: string;
  name: string;
  unitPrice: Money;
}

/* ------------------------------------------------------------------ mapping */

function pickImage(product: UcpProduct, variant?: UcpVariant): string | undefined {
  return variant?.media?.find((m) => m.type === "image")?.url ?? product.media?.find((m) => m.type === "image")?.url;
}

function totalOfType(payload: UcpCartPayload, type: string): number | undefined {
  return payload.totals?.find((t) => t.type === type)?.amount;
}

export interface ShopifyUcpOptions {
  domain: string;
  endpoint: string;
  name?: string;
  country?: string;
  currency?: string;
}

/**
 * Shopify UCP adapter -- the one real, unauthenticated, end-to-end path.
 *
 * Capabilities are `discovery`, `detail`, `cart` and `handoff`. NOT `checkout`:
 * completing a payment needs a Dev Dashboard token with a hand-granted
 * purchase permission, and Shopify staff have stated there is no self-service
 * route to it. Hand-off is therefore the ceiling of this access tier, not a
 * choice -- which is convenient, because it means no code path here can move
 * real money even by mistake.
 */
export class ShopifyUcpAdapter implements StoreAdapter {
  readonly manifest: StoreManifest;
  readonly #client: UcpClient;
  readonly #cache = new Map<string, Cached>();
  readonly #snapshotKey: string;

  constructor(opts: ShopifyUcpOptions) {
    this.#snapshotKey = opts.domain.replace(/\./g, "-");
    this.#client = new UcpClient({ endpoint: opts.endpoint, domain: opts.domain });
    this.manifest = {
      id: `shp:${opts.domain}`,
      name: opts.name ?? opts.domain,
      country: (opts.country ?? "US").toUpperCase(),
      currency: (opts.currency ?? "USD").toUpperCase(),
      language: "en",
      categories: ["general", "grocery", "apparel"],
      mode: "native",
      auth: "none",
      capabilities: ["discovery", "detail", "cart", "handoff"],
      endpoint: opts.endpoint,
      domain: opts.domain,
    };
  }

  /** Raw upstream size of the last search, for the benchmark's honest baseline. */
  lastRawBytes = 0;

  async search(q: SearchQuery, ctx: AdapterCtx): Promise<Product[]> {
    const { payload, rawBytes } = await this.#client.call<UcpSearchPayload>(
      "search_catalog",
      {
        catalog: {
          query: q.query,
          context: {
            currency: q.currency ?? ctx.currency ?? this.manifest.currency,
            address_country: q.country ?? ctx.country ?? this.manifest.country,
          },
        },
      },
      ctx,
      { snapshotKey: this.#snapshotKey },
    );
    this.lastRawBytes = rawBytes;

    const products = payload.products ?? [];
    return products.slice(0, q.maxResults ?? 10).map((p) => this.#normalise(p));
  }

  #normalise(p: UcpProduct): Product {
    const variant = p.variants?.[0];
    const min = p.price_range?.min ?? variant?.price;
    const currency = (min?.currency ?? this.manifest.currency).toUpperCase();
    const price = fromMinor(min?.amount ?? 0, currency);

    // Vendor text is untrusted. The name is the ONLY vendor string that ever
    // reaches the approval screen, so it gets the strict treatment.
    const nameSource = variant?.title && p.variants?.length === 1 ? `${p.title} — ${variant.title}` : p.title;
    const name = sanitiseProductName(nameSource).text;

    // Minted against the MANIFEST ID, not the domain. parseProductId verifies
    // an id by re-deriving the tag from each store the registry knows, and the
    // registry keys stores by manifest id -- so minting under the bare domain
    // produced ids that looked correct and never resolved, which silently
    // broke every tier-2 call against a real store while search kept working.
    const id = mintProductId(this.manifest.id, p.id);
    if (variant?.id) {
      this.#cache.set(id, {
        nativeProductId: p.id,
        variantId: variant.id,
        name,
        unitPrice: fromMinor(variant.price?.amount ?? min?.amount ?? 0, currency),
      });
    }

    const cat = inferCategory(p.categories?.join(" "), p.tags?.join(" "), p.title);
    const product: Product = {
      id,
      name,
      price,
      source: this.manifest.domain!,
      mode: "native",
      // Shopify UCP exposes no rating. We leave it absent rather than
      // inventing one -- a fabricated rating is worse than a missing field.
    };

    const image = pickImage(p, variant);
    if (image) product.image = image;
    if (p.url) product.url = p.url;

    const attrs: Record<string, unknown> = { cat };
    const size = variant?.options?.find((o) => /size|weight/i.test(o.name))?.label;
    const colour = variant?.options?.find((o) => /colou?r/i.test(o.name))?.label;
    if (cat === "apparel") {
      if (size) attrs["size"] = size;
      if (colour) attrs["colour"] = colour;
    } else if (cat === "grocery") {
      if (size) attrs["size"] = size;
    }
    product.attrs = attrs as Product["attrs"];

    return product;
  }

  async detail(id: string, include: Include[], ctx: AdapterCtx): Promise<ProductDetail> {
    const cached = this.#cache.get(id);
    if (!cached) {
      throw new Error(
        `Unknown product id for ${this.manifest.domain}. Ids are server-minted; search first, then request detail.`,
      );
    }

    const { payload, rawBytes } = await this.#client.call<
      { product?: UcpProduct; products?: UcpProduct[] } & UcpProduct
    >("get_product", { catalog: { id: cached.nativeProductId } }, ctx, {
      snapshotKey: this.#snapshotKey,
    });
    // Every call that fetches must refresh this. Leaving it at the previous
    // search's figure made the token report credit tier-2 with bytes it never
    // received -- a flattering number, and exactly the one a sceptical judge
    // asks how you computed.
    this.lastRawBytes = rawBytes;

    // Under snapshot replay there is only one capture per store -- the search
    // response -- so a lookup comes back as `{products: [...]}` rather than a
    // single product. Resolve it out of the list instead of normalising the
    // envelope, which is what previously turned the offline drill's tier-2
    // step into a TypeError inside id minting.
    const p = (Array.isArray(payload.products)
      ? payload.products.find((c) => c.id === cached.nativeProductId)
      : (payload.product ?? payload)) as UcpProduct | undefined;

    if (!p?.id) {
      throw new Error(
        `No product ${cached.nativeProductId} in the ${ctx.snapshots ? "snapshot" : "response"} from ${this.manifest.domain}.`,
      );
    }

    const base = this.#normalise(p);
    const flags: string[] = [];
    const detail: ProductDetail = { ...base };

    if (include.includes("description")) {
      const s = sanitiseText(p.description?.html, { maxLength: 1200 });
      detail.description = s.text;
      flags.push(...s.flags);
    }
    if (include.includes("variants")) {
      detail.variants = (p.variants ?? []).slice(0, 20).map((v) => ({
        id: v.id,
        title: sanitiseText(v.title, { maxLength: 80 }).text,
        price: fromMinor(v.price?.amount ?? 0, (v.price?.currency ?? this.manifest.currency).toUpperCase()),
        ...(v.sku ? { sku: v.sku } : {}),
        ...(v.availability?.available !== undefined ? { available: v.availability.available } : {}),
      }));
    }
    if (include.includes("stock")) {
      const anyAvailable = (p.variants ?? []).some((v) => v.availability?.available);
      detail.stock = anyAvailable ? "in_stock" : "out_of_stock";
    }

    detail._meta = { provenance: PROVENANCE_NOTE, ...(flags.length ? { flags: [...new Set(flags)] } : {}) };
    return detail;
  }

  /**
   * Build a REAL server-side cart. This creates no charge and takes no payment
   * details -- it is the state Shopify itself would be in if a human had
   * clicked "add to cart", including any merchant discount, which applies
   * server-side without us asking.
   */
  async buildCart(items: Array<{ id: string; quantity: number }>, ctx: AdapterCtx): Promise<RawCart> {
    const resolved = items.map((i) => {
      const cached = this.#cache.get(i.id);
      if (!cached) throw new Error(`Unknown product id "${i.id}" for ${this.manifest.domain}.`);
      return { ...i, cached };
    });

    const { payload } = await this.#client.call<UcpCartPayload>(
      "create_cart",
      {
        cart: {
          line_items: resolved.map((r) => ({ item: { id: r.cached.variantId }, quantity: r.quantity })),
          context: { address_country: ctx.country ?? this.manifest.country, currency: this.manifest.currency },
        },
      },
      ctx,
      { snapshotKey: this.#snapshotKey },
    );

    const currency = (payload.currency ?? this.manifest.currency).toUpperCase();
    const subtotalMinor = totalOfType(payload, "subtotal");
    const totalMinor = totalOfType(payload, "total");

    /*
     * The lines come from the CART, not from what we asked for.
     *
     * These diverge whenever the merchant does not give us exactly what we
     * requested -- a quantity clamped to available stock, a line merged, a
     * price that moved between search and cart. Echoing the request back would
     * put a line on the human's approval banner that does not add up to the
     * total underneath it, on the one surface that has to be trustworthy. So
     * the merchant's own cart is authoritative, and the request is only a
     * fallback for a store that returns no lines at all.
     */
    const byVariant = new Map(resolved.map((r) => [r.cached.variantId, r]));
    const upstream = payload.line_items ?? [];
    const lineItems: CartLineItem[] = upstream.length
      ? upstream.map((li) => {
          const variantId = li.item?.id ?? "";
          const match = byVariant.get(variantId);
          const unitMinor = li.item?.price;
          return {
            id: match?.id ?? variantId,
            variantId,
            quantity: li.quantity ?? 1,
            name: match?.cached.name ?? sanitiseText(li.item?.title ?? li.title, { maxLength: 80 }).text,
            unitPrice:
              unitMinor !== undefined
                ? fromMinor(unitMinor, currency)
                : (match?.cached.unitPrice ?? fromMinor(0, currency)),
          };
        })
      : resolved.map((r) => ({
          id: r.id,
          variantId: r.cached.variantId,
          quantity: r.quantity,
          name: r.cached.name,
          unitPrice: r.cached.unitPrice,
        }));

    const adjustments = (payload.totals ?? [])
      .filter((t) => t.type !== "subtotal" && t.type !== "total")
      .map((t) => ({
        type: t.type,
        amount: fromMinor(t.amount, currency),
        // display_text is merchant-authored, so it is sanitised like any vendor string.
        label: sanitiseText(t.display_text ?? t.type, { maxLength: 60 }).text,
      }));

    return {
      cartId: payload.id ?? "",
      lineItems,
      subtotal: fromMinor(subtotalMinor ?? 0, currency),
      total: fromMinor(totalMinor ?? subtotalMinor ?? 0, currency),
      adjustments,
      handoffUrl: resolveHandoffUrl(payload as Record<string, unknown>, ctx.log),
      ...(payload.expires_at ? { expiresAt: payload.expires_at } : {}),
    };
  }

  async handoff(cartId: string, ctx: AdapterCtx): Promise<{ handoffUrl: string }> {
    const { payload } = await this.#client.call<UcpCartPayload>("get_cart", { id: cartId }, ctx);
    const url = resolveHandoffUrl(payload as Record<string, unknown>, ctx.log);
    if (!url) throw new Error(`No hand-off URL on cart ${cartId} at ${this.manifest.domain}.`);
    return { handoffUrl: url };
  }
}
