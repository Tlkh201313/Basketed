import {
  fromMinor,
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
import type { BookedSlot, DeliverySlot } from "@basketed/core";
import { mintProductId } from "../ids.js";
import { DELIVERY_SLOTS_QUERY, FULFILMENT_MUTATION, SLOTS_MFE, flattenBooking, flattenSlots } from "./slots.js";
import type { AdapterCtx, CartLineItem, RawCart, StoreAdapter } from "../types.js";

/**
 * Real Tesco, S16.
 *
 * Two of Tesco's own endpoints, ported from public GitHub prototypes and
 * verified live before a line of this file was written:
 *
 *   - `search.api.tesco.com/search` -- Tesco's own product search. No auth,
 *     no API key -- it is the same request tesco.com's own frontend makes.
 *   - `xapi.tesco.com` GraphQL -- product detail (price, image) by TPNB, and,
 *     authenticated, the customer's real basket (`GetBasket`/`UpdateBasket`).
 *     The API key below is not a secret: it is public, embedded in Tesco's
 *     own frontend JS, and required on every request regardless of whether
 *     that request is also authenticated.
 *
 * This is `mode: "native"` for search/detail (Tesco's own live data, same
 * standing as Shopify UCP) because it is exactly that: no scraping, no DOM
 * parsing, a JSON API returning real prices. It is a genuinely different
 * claim from `sim:tesco`, which stays exactly as it was -- untouched, still
 * fixture-backed, still what the offline drill depends on.
 *
 * Cart needs the shopper's own session, which nobody can hand out an API key
 * for -- there is no "Sign in with Tesco". `buildCart` sends whatever the
 * Connect-stores page has sealed for this store (via ctx.http, never seen by
 * this file -- see AdapterCtx and vault/authorizedFetch). That is a header
 * SET, not one value: Tesco's basket authenticates on `authorization` and
 * `customer-uuid` together, and a bearer alone returns a basket belonging to
 * nobody in particular. If the session is missing or expired, the call fails
 * with Tesco's own real error -- this file does not paper over that with a
 * fake cart, per the project's "never claim success it cannot back" rule.
 */

const SEARCH_URL = "https://search.api.tesco.com/search";
const GRAPHQL_URL = "https://xapi.tesco.com/";

/** The micro-frontend tesco.com identifies its basket calls as. */
const BASKET_MFE = "mfe-basket";
const API_KEY = "TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA"; // public, embedded in Tesco's own frontend
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PRODUCT_QUERY = `
query GetProductByTpnb($tpnb: String) {
  product(tpnb: $tpnb) {
    id
    gtin
    title
    defaultImageUrl
    price { actual unitPrice unitOfMeasure }
    details { packSize { value units } }
  }
}`;

const GET_BASKET_QUERY = `
query GetBasket {
  basket {
    id
    items {
      id
      quantity
      cost
      product { id title: baseProductId isForSale __typename }
      __typename
    }
    __typename
  }
}`;

const UPDATE_BASKET_MUTATION = `
mutation UpdateBasket($items: [BasketLineItemInputType], $orderId: ID) {
  basket(items: $items, orderId: $orderId) {
    id
    items { id quantity cost product { id __typename } __typename }
    updates { items { id successful __typename } __typename }
    __typename
  }
}`;

interface TescoSearchResponse {
  uk?: { ghs?: { products?: { results?: Array<{ tpnb?: number }>; totals?: { all?: number } } } };
}

interface TescoGraphQLEnvelope<T> {
  data?: T;
  status?: number;
  errors?: Array<{ message?: string }>;
}

interface TescoProductNode {
  id?: string;
  gtin?: string;
  title?: string;
  defaultImageUrl?: string;
  price?: { actual?: number; unitPrice?: number; unitOfMeasure?: string };
  details?: { packSize?: Array<{ value?: string; units?: string }> };
}

interface TescoBasketItem {
  id?: string;
  quantity?: number;
  cost?: number;
  product?: { id?: string; title?: string; isForSale?: boolean };
}

interface TescoBasket {
  id?: string;
  items?: TescoBasketItem[];
}

/** Cached so detail() and buildCart() can resolve back to Tesco's own ids. */
interface Cached {
  tescoId: string;
  tpnb: string;
  name: string;
}

/**
 * Never sets Authorization itself -- an adapter has no access to a secret by
 * construction (see AdapterCtx). When ctx.http is the vault-wrapped fetch for
 * this store (see runtime.ts), it attaches every header the sealed session
 * holds -- `authorization` and `customer-uuid` for Tesco -- to every request
 * these headers go out with, including the unauthenticated search/detail
 * calls, which Tesco's API ignores when nothing needs them.
 */
function graphqlHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    "x-apikey": API_KEY,
    region: "UK",
    language: "en-GB",
    "User-Agent": USER_AGENT,
  };
}

export class TescoAdapter implements StoreAdapter {
  readonly manifest: StoreManifest;
  readonly #cache = new Map<string, Cached>();
  lastRawBytes = 0;

  constructor() {
    this.manifest = {
      id: "tsc:tesco",
      name: "Tesco",
      country: "GB",
      currency: "GBP",
      language: "en",
      categories: ["grocery", "general"],
      mode: "native",
      auth: "none",
      capabilities: ["discovery", "detail", "cart", "slots"],
      domain: "tesco.com",
    };
  }

  async search(q: SearchQuery, ctx: AdapterCtx): Promise<Product[]> {
    this.lastRawBytes = 0;
    const count = Math.min(q.maxResults ?? 10, 50);
    const url = `${SEARCH_URL}?${new URLSearchParams({
      distchannel: "ghs",
      query: q.query,
      count: String(count),
      geo: "uk",
    })}`;
    const res = await ctx.http(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Tesco search returned HTTP ${res.status}.`);
    const bodyText = await res.text();
    this.lastRawBytes = bodyText.length;
    let payload: TescoSearchResponse;
    try {
      payload = JSON.parse(bodyText) as TescoSearchResponse;
    } catch {
      throw new Error(`Tesco search returned non-JSON HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    const tpnbs = (payload.uk?.ghs?.products?.results ?? [])
      .map((r) => r.tpnb)
      .filter((t): t is number => typeof t === "number")
      .slice(0, count);
    if (!tpnbs.length) return [];

    const pairs = await this.#hydrate(tpnbs, ctx);
    return pairs.map(({ tpnb, node }) => this.#normalise(tpnb, node)).filter((p): p is Product => p !== null);
  }

  /**
   * Batched by TPNB, but a batch reply can come back shorter than the batch
   * sent (one item 404s, the rest don't) -- so results are paired back to
   * their TPNB by array position, not assumed to still line up after a
   * naive filter. `node.id` (Tesco's own internal product id, used for the
   * basket API) is a DIFFERENT number from the TPNB search returned; losing
   * that distinction is exactly the bug that made detail() ask Tesco for a
   * product using its own id as if it were a TPNB, and got "not found" for
   * every product, every time.
   */
  async #hydrate(tpnbs: number[], ctx: AdapterCtx): Promise<Array<{ tpnb: number; node: TescoProductNode }>> {
    const batch = tpnbs.map((tpnb) => ({
      operationName: "GetProductByTpnb",
      variables: { tpnb: String(tpnb) },
      query: PRODUCT_QUERY,
    }));
    const res = await ctx.http(GRAPHQL_URL, {
      method: "POST",
      headers: graphqlHeaders(),
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`Tesco product lookup returned HTTP ${res.status}.`);
    const bodyText = await res.text();
    this.lastRawBytes += bodyText.length;
    let envelopes: Array<TescoGraphQLEnvelope<{ product?: TescoProductNode }>>;
    try {
      envelopes = JSON.parse(bodyText) as Array<TescoGraphQLEnvelope<{ product?: TescoProductNode }>>;
    } catch {
      throw new Error(`Tesco product lookup non-JSON HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    const pairs: Array<{ tpnb: number; node: TescoProductNode }> = [];
    envelopes.forEach((e, i) => {
      const node = e.data?.product;
      const tpnb = tpnbs[i];
      if (node?.id && tpnb !== undefined) pairs.push({ tpnb, node });
    });
    return pairs;
  }

  #normalise(tpnb: number, node: TescoProductNode): Product | null {
    if (!node.id || !node.title) return null;
    const name = sanitiseProductName(node.title).text;
    // Minted against the TPNB, not Tesco's internal product id -- the TPNB is
    // what search and re-hydrate both key on; the internal id is kept only
    // for the basket API, which wants it specifically (see buildCart).
    const id = mintProductId(this.manifest.id, String(tpnb));
    this.#cache.set(id, { tescoId: node.id, tpnb: String(tpnb), name });

    const packSize = node.details?.packSize?.[0];
    const size = packSize ? `${packSize.value ?? ""}${packSize.units ?? ""}`.trim() : undefined;

    const product: Product = {
      id,
      name,
      price: fromMinor(Math.round((node.price?.actual ?? 0) * 100), this.manifest.currency),
      source: this.manifest.domain!,
      mode: "native",
    };
    if (node.defaultImageUrl) product.image = node.defaultImageUrl;
    const attrs: Record<string, unknown> = { cat: inferCategory(name) };
    if (size) attrs["size"] = size;
    product.attrs = attrs as Product["attrs"];
    return product;
  }

  async detail(id: string, include: Include[], ctx: AdapterCtx): Promise<ProductDetail> {
    this.lastRawBytes = 0;
    const cached = this.#cache.get(id);
    if (!cached) {
      throw new Error("Unknown product id for Tesco. Ids are server-minted; search first, then request detail.");
    }
    const pairs = await this.#hydrate([Number(cached.tpnb)], ctx);
    const pair = pairs[0];
    if (!pair) throw new Error(`Tesco no longer has product ${cached.tpnb}.`);

    const base = this.#normalise(pair.tpnb, pair.node);
    if (!base) throw new Error(`Tesco returned an incomplete record for ${cached.tpnb}.`);
    const detail: ProductDetail = { ...base };

    if (include.includes("stock")) detail.stock = "in_stock";
    detail._meta = { provenance: PROVENANCE_NOTE };
    return detail;
  }

  /**
   * A real Tesco basket, via the shopper's own sealed session (see the header
   * comment). Fails loudly -- Tesco's real HTTP status, not a fabricated
   * cart -- when that session is missing, expired, or insufficient.
   */
  async buildCart(items: Array<{ id: string; quantity: number }>, ctx: AdapterCtx): Promise<RawCart> {
    this.lastRawBytes = 0;
    const resolved = items.map((i) => {
      const cached = this.#cache.get(i.id);
      if (!cached) throw new Error(`Unknown product id "${i.id}" for Tesco.`);
      return { ...i, cached };
    });

    const basket = await this.#basketOp(GET_BASKET_QUERY, {}, ctx);
    const orderId = basket.id;
    if (!orderId) {
      throw new Error(
        "Tesco did not return a basket -- the connected token is likely missing, expired, or belongs to a " +
          "session with no active basket. Reconnect Tesco from the Connect-stores page.",
      );
    }

    const update = await this.#basketOp(
      UPDATE_BASKET_MUTATION,
      {
        orderId,
        items: resolved.map((r) => ({
          adjustment: false,
          id: r.cached.tescoId,
          newValue: r.quantity,
          newUnitChoice: "pcs",
        })),
      },
      ctx,
    );

    const updates = (update as unknown as { updates?: { items?: Array<{ id?: string; successful?: boolean }> } }).updates?.items ?? [];
    const failed = updates.filter((u) => u.successful === false);
    if (failed.length) {
      throw new Error(`Tesco refused ${failed.map((f) => f.id).join(", ")}: out of stock or limit — remove and retry`);
    }
    const currency = this.manifest.currency;
    const upstream = update.items ?? [];
    const byId = new Map(resolved.map((r) => [r.cached.tescoId, r]));
    const lineItems: CartLineItem[] = upstream.length
      ? upstream.map((it) => {
          const tescoId = it.product?.id ?? it.id ?? "";
          const match = byId.get(tescoId);
          return {
            id: match?.id ?? tescoId,
            variantId: tescoId,
            quantity: it.quantity ?? match?.quantity ?? 1,
            name: match?.cached.name ?? "Tesco item",
            unitPrice: fromMinor(Math.round(((it.cost ?? 0) / (it.quantity || 1)) * 100), currency),
          };
        })
      : resolved.map((r) => ({
          id: r.id,
          variantId: r.cached.tescoId,
          quantity: r.quantity,
          name: r.cached.name,
          unitPrice: fromMinor(0, currency),
        }));

    const total = upstream.reduce((sum, it) => sum + (it.cost ?? 0), 0);

    return {
      cartId: orderId,
      lineItems,
      subtotal: fromMinor(Math.round(total * 100), currency),
      total: fromMinor(Math.round(total * 100), currency),
      adjustments: [],
      // Real basket, real domain -- the shopper finishes payment themselves.
      // Never fabricated: this is the same trolley the app itself opens.
      handoffUrl: "https://www.tesco.com/groceries/en-GB/trolley",
    };
  }

  /**
   * Tesco's xapi ALWAYS wants (and returns) a JSON array, even for one
   * operation -- the TPNB hydrate batch above makes this obvious, but a
   * single basket operation is easy to reach for a bare object instead,
   * which is a real request Tesco's API will not answer usefully.
   */
  async #op<T>(query: string, variables: Record<string, unknown>, mfeName: string, ctx: AdapterCtx): Promise<T> {
    const operationName = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "Op";
    const res = await ctx.http(GRAPHQL_URL, {
      method: "POST",
      headers: graphqlHeaders(),
      // `extensions.mfeName` because tesco.com's own frontend sends it and the
      // gateway routes on it -- an operation without it is not the request the
      // site makes.
      body: JSON.stringify([{ operationName, variables, extensions: { mfeName }, query }]),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("Tesco refused the stored session (401/403) -- it is expired or invalid. Reconnect Tesco.");
    }
    if (!res.ok) throw new Error(`Tesco ${operationName} returned HTTP ${res.status}.`);
    const bodyText = await res.text();
    this.lastRawBytes += bodyText.length;
    let envelopes: Array<TescoGraphQLEnvelope<T>>;
    try {
      envelopes = JSON.parse(bodyText) as Array<TescoGraphQLEnvelope<T>>;
    } catch {
      throw new Error(`Tesco ${operationName} non-JSON HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    const envelope = envelopes[0];
    if (!envelope) throw new Error(`Tesco ${operationName} returned an empty response.`);
    if (envelope.errors?.length) {
      throw new Error(`Tesco ${operationName} error: ${envelope.errors.map((e) => e.message).join("; ")}`);
    }
    return (envelope.data ?? ({} as T)) as T;
  }

  async #basketOp(query: string, variables: Record<string, unknown>, ctx: AdapterCtx): Promise<TescoBasket> {
    const data = await this.#op<{ basket?: TescoBasket }>(query, variables, BASKET_MFE, ctx);
    return data.basket ?? {};
  }

  /**
   * Delivery windows for a date range.
   *
   * Both halves of the tier live here because the registry refuses one without
   * the other -- see StoreAdapter.slots. Unavailable windows are dropped: an
   * agent can only act on one it can book.
   */
  async slots(range: { start: string; end: string }, ctx: AdapterCtx): Promise<DeliverySlot[]> {
    const data = await this.#op<{ delivery?: unknown }>(
      DELIVERY_SLOTS_QUERY,
      { start: range.start, end: range.end, type: "DELIVERY_VAN" },
      SLOTS_MFE,
      ctx,
    );
    const raw = Array.isArray(data.delivery) ? (data.delivery as Array<Record<string, unknown>>) : [];
    return flattenSlots(raw, this.manifest.currency, false);
  }

  /**
   * Take one.
   *
   * A commitment against the shopper's real account, so it is approval-gated
   * upstream and never reachable under fast-mode. Tesco answering with an
   * unbooked slot means somebody else took the window between listing it and
   * this call -- said plainly, rather than reported as a reservation nobody
   * holds.
   */
  async bookSlot(slotId: string, ctx: AdapterCtx): Promise<BookedSlot> {
    const data = await this.#op<{ fulfilment?: { slot?: Record<string, unknown> } }>(
      FULFILMENT_MUTATION,
      { slotId, action: "BOOK" },
      SLOTS_MFE,
      ctx,
    );
    const booked = flattenBooking(data.fulfilment ?? {});
    if (!booked) {
      throw new Error(
        `Tesco did not confirm slot ${slotId}. It was most likely taken between listing it and booking it -- ` +
          `list slots again and pick another.`,
      );
    }
    return booked;
  }
}
