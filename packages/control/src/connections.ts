import type { CredentialKind } from "@basketed/vault";

/**
 * What connecting a store actually means, per store (S14).
 *
 * This table exists because the honest answer differs wildly by retailer, and
 * a panel that renders one "Connect" button for all of them would be lying
 * about three different situations at once:
 *
 *   - **Shopify UCP merchants** need nothing. Their agentic endpoint is
 *     anonymous; there is no account to connect and adding a login box would
 *     invent a step that does not exist.
 *   - **Tesco, Costco, Walmart, Amazon** have no consumer API and no consumer
 *     OAuth. Nobody -- us or anyone else -- can hand you a "Sign in with
 *     Tesco" button, because Tesco does not publish one. What CAN be done is
 *     hold the credential or session you already have, encrypted, so that an
 *     adapter written against it later has something to use.
 *   - **A store that later ships real OAuth** slots in as `kind: "token"`
 *     with `oauth: true` and nothing else about the panel changes.
 *
 * `reach` is the sentence the card shows under the store name. It is written
 * to be uncomfortable where the truth is uncomfortable: a connected store whose
 * products are still fixtures says exactly that, on the card, in the panel.
 */

export type ConnectMethod = CredentialKind;

export interface StoreAuthPolicy {
  /** Empty when there is nothing to connect. */
  methods: ConnectMethod[];
  /** True once a retailer publishes a real consumer OAuth flow. None do today. */
  oauth: boolean;
  /** One line, shown on the card. Says what a connection here can actually do. */
  reach: string;
}

const ANONYMOUS: StoreAuthPolicy = {
  methods: [],
  oauth: false,
  reach: "Anonymous. This merchant's agentic endpoint needs no account, so there is nothing to connect.",
};

/**
 * The retailers a person actually shops at, none of which expose a consumer
 * API. Their products in Basketed are fixtures, and a stored credential does
 * not change that today -- it is held for the adapter that would use it.
 */
const NO_PUBLIC_API: Record<string, string> = {
  "sim:tesco": "No public shopping API. Tesco is reachable only through a licensed data provider.",
  "sim:amazon":
    "No consumer API. Login with Amazon is identity only; SP-API is for sellers and the Product Advertising API is affiliate links.",
  "sim:costco": "No public API of any kind, and membership-gated on top.",
  "sim:walmart": "No consumer API. Walmart publishes seller and affiliate APIs only.",
  "sim:shopee": "Open Platform is seller-side. No consumer cart API.",
  "sim:taobao": "Open Platform is seller-side, and gated by a Chinese business licence.",
  "sim:ikea": "No public API. The unofficial endpoints are undocumented and change without notice.",
};

export function authPolicyFor(store: { id: string; mode: string }): StoreAuthPolicy {
  if (store.mode === "native") return ANONYMOUS;

  const why = NO_PUBLIC_API[store.id];
  if (why) {
    return {
      // Password for the account you already have; session token for people
      // who would rather hand over something revocable than a password.
      methods: ["password", "token"],
      oauth: false,
      reach: `${why} Products here are fixtures; a stored credential is held for the adapter that would use it, and buys nothing until one exists.`,
    };
  }

  return {
    methods: ["token"],
    oauth: false,
    reach: "Fixture-backed. A token is held encrypted for a future adapter.",
  };
}

/** The label the connect form puts on the secret field. */
export function secretLabel(method: ConnectMethod): string {
  return method === "password" ? "Password" : method === "cookie" ? "Session cookie" : "Access token";
}

export function methodLabel(method: ConnectMethod): string {
  return method === "password" ? "Email &amp; password" : method === "cookie" ? "Session cookie" : "Access token";
}
