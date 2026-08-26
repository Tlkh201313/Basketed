/**
 * The purchase-route ladder (§1.4), rungs 2 and 4.
 *
 * Rung 2 -- cart permalinks -- is the sleeper win: Shopify and WooCommerce both
 * accept a prefilled cart as a plain URL, so this is pure string construction
 * with NO network call at all. It works offline, costs nothing, and covers
 * millions of stores.
 *
 * Rung 4 -- product deep links -- is what we return when no cart route exists
 * at any price. It is a product page, not a cart, and it says so. Quietly
 * presenting one as the other would be the dishonest option.
 */

export type PurchaseRung = 1 | 2 | 3 | 4;

export interface PurchaseRoute {
  rung: PurchaseRung;
  url: string;
  /** Plain-language statement of how far this route actually goes. */
  reach: string;
  /** True when we have not verified this route end to end. Shown in the UI. */
  unverified: boolean;
}

/**
 * Shopify cart permalink. Multi-item syntax is comma-separated
 * `variantId:quantity` pairs, and `?discount=CODE` is accepted.
 *
 * Variant ids must be numeric -- Shopify's GraphQL `gid://shopify/ProductVariant/123`
 * form is NOT accepted here, so the numeric tail is what goes in.
 */
export function shopifyCartPermalink(
  domain: string,
  items: Array<{ variantId: string; quantity: number }>,
  discountCode?: string,
): PurchaseRoute {
  const pairs = items
    .map((i) => `${i.variantId.split("/").pop() ?? i.variantId}:${i.quantity}`)
    .join(",");
  const qs = discountCode ? `?discount=${encodeURIComponent(discountCode)}` : "";
  return {
    rung: 2,
    url: `https://${domain}/cart/${pairs}${qs}`,
    reach: "Prefilled cart on the merchant's own storefront. The human completes checkout.",
    unverified: false,
  };
}

/** WooCommerce add-to-cart. One product per link; the param is a product id. */
export function wooCartPermalink(domain: string, productId: string, quantity = 1): PurchaseRoute {
  return {
    rung: 2,
    url: `https://${domain}/?add-to-cart=${encodeURIComponent(productId)}&quantity=${quantity}`,
    reach: "Prefilled cart on the merchant's own WooCommerce storefront.",
    unverified: false,
  };
}

/**
 * Rung 4 -- a product or search page.
 *
 * For Amazon and the UK grocers there is no cart route at any price: Amazon's
 * `/gp/aws/cart/add.html` now redirects to an Associates sign-in and is
 * verified broken. So a page link is what exists, and a page link is what we
 * return -- labelled as one.
 */
export function productDeepLink(url: string, retailer: string): PurchaseRoute {
  return {
    rung: 4,
    url,
    reach: `Product page at ${retailer}. This is NOT a cart -- nothing is added and nothing is reserved.`,
    unverified: false,
  };
}

/** Human-readable summary used in tool responses and the panel. */
export function describeRoute(route: PurchaseRoute): string {
  const label: Record<PurchaseRung, string> = {
    1: "UCP cart + checkout",
    2: "cart permalink",
    3: "retailer hand-off link",
    4: "product page",
  };
  return `${label[route.rung]} — ${route.reach}${route.unverified ? " (unverified route)" : ""}`;
}
