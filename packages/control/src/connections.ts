import type { CredentialKind } from "@basketed/vault";

/**
 * What connecting a store actually means, per store.
 *
 * This table exists because the honest answer differs by retailer, and a
 * panel that rendered one identical "Connect" button for all of them would be
 * lying about three different situations at once:
 *
 *   - **Shopify UCP merchants** need nothing. Their agentic endpoint is
 *     anonymous; there is no account to connect and adding a login step would
 *     invent one that does not exist.
 *   - **Amazon, IKEA, Target and the other scrape stores** are reached
 *     signed-out, through their own public pages. Search works without an
 *     account. Connect is not offered until an adapter actually consumes a
 *     session -- sealing cookies that nothing uses is a fake "connected" state.
 *   - **Tesco** search is public; the basket is not. Connect opens tesco.com,
 *     the human signs in there, and Basketed lifts `authorization` plus
 *     `customer-uuid` from Tesco's own `xapi.tesco.com` call (the same pair
 *     GavinAttard/tesco-grocery-mcp sends, captured instead of pasted).
 *
 * ## Why there is no password box anywhere in this panel (S19)
 *
 * Until S19 every one of these stores also offered "email & password", typed
 * into a Basketed form. That is gone, and it is not coming back. Typing a
 * retailer password into someone else's form is the exact shape of every
 * credential-phishing page ever built, and no amount of "but it is sealed
 * with AES-256-GCM afterwards" changes what the user had to do to get there:
 * hand a password to software that is not the retailer. The Chrome flow asks
 * for the one thing that is safe to ask for -- that they sign in on the
 * retailer's own page, in a real browser, at the real URL, with the padlock
 * they can check themselves. Basketed never sees the password, only the
 * session it produced.
 *
 * `reach` is the sentence the card shows under the store name.
 */

export type ConnectMethod = CredentialKind;

/** Where "Connect" sends a human, and what to read back afterwards. */
export interface ChromeLogin {
  /** Where the tab lands first: a page that reveals whether you are signed in. */
  url: string;
  /**
   * Where to send someone who turns out NOT to be signed in. Landing a
   * signed-out shopper on a homepage and leaving them to find the account
   * menu is a worse flow than opening the login page for them.
   */
  loginUrl: string;
  domains: string[];
  /**
   * Cookie-name prefixes that only a signed-in session has. The server polls
   * for one of these so the panel can say "you are in" by itself instead of
   * asking a human to confirm a login they just performed.
   *
   * Best-effort signatures, not a contract: none of these retailers documents
   * its cookies and any of them may rename one without notice. A miss stays
   * recoverable -- the capture route never consults this list.
   */
  authCookies: string[];
  /**
   * Headers to lift off the store's own API call, when the credential is not
   * in the cookie jar at all (S21).
   *
   * Tesco is the case that forced this open. Its basket API authenticates on
   * `authorization` AND `customer-uuid` together -- a bearer alone returns a
   * basket that is not yours, which is exactly the "connected but broken"
   * failure that is worst to debug. GavinAttard/tesco-grocery-mcp (MIT) sends
   * the same pair, which is where the second header came from; the difference
   * is that it asks a human to copy both out of DevTools, and this lifts them
   * from the tab they just signed into.
   *
   * Every header named here is REQUIRED. A capture missing one is refused
   * rather than sealed, because half a session succeeds here and fails later,
   * somewhere with much less context.
   */
  capture?: { match: string; headers: string[] };
}

export interface StoreAuthPolicy {
  /** Empty when there is nothing to connect. Never contains "password" (see above). */
  methods: ConnectMethod[];
  /** True once a retailer publishes a real consumer OAuth flow. None do today. */
  oauth: boolean;
  /** One line, shown on the card. Says what a connection here can actually do. */
  reach: string;
  /** Set for every store that has an account to sign in to. */
  chromeLogin: ChromeLogin | null;
}

const ANONYMOUS: StoreAuthPolicy = {
  methods: [],
  oauth: false,
  reach: "Anonymous. This merchant's agentic endpoint needs no account, so there is nothing to connect.",
  chromeLogin: null,
};

const DEMO: StoreAuthPolicy = {
  methods: [],
  oauth: false,
  reach: "Demo catalogue. Search works offline; there is no real account to connect.",
  chromeLogin: null,
};

/**
 * Every store whose adapter actually consumes a session, and how to reach it.
 *
 * Demo (`sim:*`) catalogues used to have Connect buttons that sealed cookies
 * nothing ever sent. That is gone: Connect exists only where a live adapter
 * will attach the captured session on the next basket call.
 */
const CHROME_LOGIN: Record<string, ChromeLogin> = {
  // Real Tesco. Basket auth is the header pair Tesco's own frontend sends to
  // xapi.tesco.com -- a bearer alone returns a basket that is not yours.
  "tsc:tesco": {
    url: "https://www.tesco.com/groceries/en-GB/",
    loginUrl: "https://www.tesco.com/account/login/en-GB",
    domains: ["tesco.com"],
    authCookies: ["_ttoken", "trefresh", "atrc_", "access_token", "OAuth.AccessToken"],
    capture: { match: "xapi.tesco.com", headers: ["authorization", "customer-uuid"] },
  },
};

/**
 * Real Tesco (S16). `mode: "native"` because search/detail genuinely are --
 * Tesco's own live API, no auth needed. That is also why it cannot fall
 * through to the generic `mode === "native"` case below: unlike Shopify UCP,
 * this store's basket DOES need a credential, so "native" here is not a
 * synonym for "nothing to connect".
 */
const REAL_TESCO_POLICY: StoreAuthPolicy = {
  methods: ["session"],
  oauth: false,
  reach:
    "Search Tesco without an account. Connect to use your real trolley: a tab opens on tesco.com, " +
    "you sign in there, and Basketed seals the session. No password is typed into Basketed.",
  chromeLogin: CHROME_LOGIN["tsc:tesco"] ?? null,
};

/**
 * Real Amazon, IKEA, Target (S17). `mode: "native"` for the same reason as
 * Tesco -- genuinely their own live pages, reaching a real signed-out shopper
 * -- but the mechanism differs and the card says so: there is no JSON API
 * here, a stealth browser renders the retailer's own public page and the
 * adapter parses what a signed-out visitor sees. Nothing to connect, because
 * nothing here needs an account.
 */
function realScrapePolicy(name: string): StoreAuthPolicy {
  return {
    methods: [],
    oauth: false,
    reach: `Live ${name} search from their public pages. No account needed.`,
    chromeLogin: null,
  };
}

const REAL_AMAZON_POLICY = realScrapePolicy("Amazon");
const REAL_IKEA_POLICY = realScrapePolicy("IKEA");
const REAL_TARGET_POLICY = realScrapePolicy("Target");

/**
 * Tesco's GraphQL gateway has sent the customer id as `customer-uuid` and as
 * `x-customer-uuid`. GavinAttard/tesco-grocery-mcp (PR #1) started sending
 * both; we do the same on the way out, and treat them as one header on the
 * way in so a capture that only saw one still authenticates.
 */
export function sessionHeaderAliases(name: string): string[] {
  const key = name.toLowerCase();
  if (key === "customer-uuid" || key === "x-customer-uuid") return ["customer-uuid", "x-customer-uuid"];
  return [key];
}

export function authPolicyFor(store: { id: string; mode: string }): StoreAuthPolicy {
  if (store.id === "tsc:tesco") return REAL_TESCO_POLICY;
  if (store.id === "amz:amazon") return REAL_AMAZON_POLICY;
  if (store.id === "ikea:ikea") return REAL_IKEA_POLICY;
  if (store.id === "tgt:target") return REAL_TARGET_POLICY;
  if (store.mode === "simulated") return DEMO;
  if (store.mode === "native") return ANONYMOUS;
  return {
    methods: [],
    oauth: false,
    reach: "Nothing to connect: this store needs no account.",
    chromeLogin: null,
  };
}

/** The label the panel puts on a held credential. */
export function secretLabel(method: ConnectMethod): string {
  return method === "cookie" ? "Session" : method === "token" ? "Access token" : "Account";
}

export function methodLabel(method: ConnectMethod): string {
  return method === "cookie" ? "Browser session" : method === "token" ? "Access token" : "Account";
}
