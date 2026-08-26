import type {
  CapabilityTier,
  Money,
  Product,
  ProductDetail,
  Include,
  SearchQuery,
  StoreManifest,
} from "@basketed/core";

/**
 * The adapter seam (§4).
 *
 * Note what AdapterCtx does NOT carry: no token, no secret, no ability to
 * resolve an account handle. The vault applies auth as a request interceptor
 * on `http` before the adapter is ever handed it, so an adapter -- including a
 * future third-party one -- cannot read a credential even by accident. That is
 * the trust boundary from §2 expressed as a type.
 */
export interface AdapterCtx {
  /** Pre-authenticated fetch. Auth is already applied; the adapter just calls it. */
  http: typeof fetch;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  /** Replay from fixtures/snapshots instead of the network (wifi-failure drill). */
  snapshots: boolean;
  /** Buyer locale hints, passed through to upstream where supported. */
  country?: string;
  currency?: string;
}

export interface CartLineItem {
  /** Basketed product id, as returned by search. */
  id: string;
  /** Upstream variant id the adapter resolved it to. */
  variantId: string;
  quantity: number;
  name: string;
  unitPrice: Money;
}

export interface RawCart {
  /** Upstream cart id. */
  cartId: string;
  lineItems: CartLineItem[];
  subtotal: Money;
  total: Money;
  /** Fees, discounts and tax, each with the merchant's own display text. */
  adjustments: Array<{ type: string; amount: Money; label: string }>;
  /**
   * Where a human finishes the purchase. Confirmed as `continue_url` on live
   * Shopify carts; resolved defensively (see shopify-ucp) because getting this
   * wrong makes purchase_confirm return nothing usable.
   */
  handoffUrl: string | null;
  expiresAt?: string;
}

export interface RawOrder {
  orderId: string;
  status: string;
  total?: Money;
  placedAt?: string;
  trackingUrl?: string;
}

/**
 * Every adapter implements the same interface regardless of mode. A simulated
 * store and a native one differ only in their manifest and where their bytes
 * come from -- which is what makes promoting one to `native` later a manifest
 * change rather than a rewrite.
 */
export interface StoreAdapter {
  manifest: StoreManifest;
  search(q: SearchQuery, ctx: AdapterCtx): Promise<Product[]>;
  detail(id: string, include: Include[], ctx: AdapterCtx): Promise<ProductDetail>;
  buildCart?(items: Array<{ id: string; quantity: number }>, ctx: AdapterCtx): Promise<RawCart>;
  handoff?(cartId: string, ctx: AdapterCtx): Promise<{ handoffUrl: string }>;
  orderStatus?(orderId: string, ctx: AdapterCtx): Promise<RawOrder>;
}

/** An adapter must not claim a tier it does not implement. Enforced, not trusted. */
export function implementedTiers(adapter: StoreAdapter): CapabilityTier[] {
  const tiers: CapabilityTier[] = [];
  if (typeof adapter.search === "function") tiers.push("discovery");
  if (typeof adapter.detail === "function") tiers.push("detail");
  if (typeof adapter.buildCart === "function") tiers.push("cart");
  if (typeof adapter.handoff === "function") tiers.push("handoff");
  return tiers;
}

/**
 * Returns the tiers an adapter CLAIMS but does not implement. A non-empty
 * result is a bug, and the conformance suite treats it as one.
 *
 * `checkout` is special-cased: nobody at our access tier can complete a payment
 * programmatically (Shopify gates it behind a hand-granted merchant token), so
 * an adapter claiming it is always wrong.
 */
export function overclaimedTiers(adapter: StoreAdapter): CapabilityTier[] {
  const actual = new Set<string>(implementedTiers(adapter));
  return adapter.manifest.capabilities.filter((t) => !actual.has(t));
}
