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

/** Where "Log in with Chrome" (S15) sends a human, and what domain to read cookies back from. */
export interface ChromeLogin {
  url: string;
  domains: string[];
}

export interface StoreAuthPolicy {
  /** Empty when there is nothing to connect. */
  methods: ConnectMethod[];
  /** True once a retailer publishes a real consumer OAuth flow. None do today. */
  oauth: boolean;
  /** One line, shown on the card. Says what a connection here can actually do. */
  reach: string;
  /** Set only for the retailers this build's Chrome-login flow targets. */
  chromeLogin: ChromeLogin | null;
}

const ANONYMOUS: StoreAuthPolicy = {
  methods: [],
  oauth: false,
  reach: "Anonymous. This merchant's agentic endpoint needs no account, so there is nothing to connect.",
  chromeLogin: null,
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

/**
 * The four this build's Chrome-login prototype targets. Real automation of a
 * real login page, against real Terms of Service that all four prohibit
 * automated access under -- including, in most of these, by the account
 * owner's own tooling. That is disclosed on the button itself, not buried
 * here; see `renderConnect` in pages.ts.
 */
const CHROME_LOGIN: Record<string, ChromeLogin> = {
  "sim:tesco": { url: "https://www.tesco.com/", domains: ["tesco.com"] },
  "sim:amazon": { url: "https://www.amazon.com/", domains: ["amazon.com"] },
  "sim:costco": { url: "https://www.costco.com/", domains: ["costco.com"] },
  "sim:walmart": { url: "https://www.walmart.com/", domains: ["walmart.com"] },
};

export function authPolicyFor(store: { id: string; mode: string }): StoreAuthPolicy {
  if (store.mode === "native") return ANONYMOUS;

  const why = NO_PUBLIC_API[store.id];
  if (why) {
    const chromeLogin = CHROME_LOGIN[store.id] ?? null;
    return {
      // Password for the account you already have; session token for people
      // who would rather hand over something revocable than a password.
      // Cookie is only offered where a session actually looks like that --
      // the four stores "Log in with Chrome" (S15) captures one from.
      methods: chromeLogin ? ["password", "token", "cookie"] : ["password", "token"],
      oauth: false,
      reach: chromeLogin
        ? `${why} Products here are fixtures; a stored credential is held for the adapter that would use it, and buys nothing until one exists. "Log in with Chrome" opens the real site and captures the session yourself -- this is real automation of their real login, which their Terms of Service does not permit even for the account owner.`
        : `${why} Products here are fixtures; a stored credential is held for the adapter that would use it, and buys nothing until one exists.`,
      chromeLogin,
    };
  }

  return {
    methods: ["token"],
    oauth: false,
    reach: "Fixture-backed. A token is held encrypted for a future adapter.",
    chromeLogin: null,
  };
}

/** The label the connect form puts on the secret field. */
export function secretLabel(method: ConnectMethod): string {
  return method === "password" ? "Password" : method === "cookie" ? "Session cookie" : "Access token";
}

export function methodLabel(method: ConnectMethod): string {
  return method === "password" ? "Email &amp; password" : method === "cookie" ? "Session cookie" : "Access token";
}
