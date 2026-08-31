import type { CredentialKind } from "@basketed/vault";

/**
 * What connecting a store actually means, per store (S14, rewritten S19).
 *
 * This table exists because the honest answer differs by retailer, and a
 * panel that rendered one identical "Connect" button for all of them would be
 * lying about three different situations at once:
 *
 *   - **Shopify UCP merchants** need nothing. Their agentic endpoint is
 *     anonymous; there is no account to connect and adding a login step would
 *     invent one that does not exist.
 *   - **Amazon, IKEA and Target** are reached signed-out, through their own
 *     public pages. Nothing to connect either -- and that is a feature, not a
 *     gap: the data is there without an account.
 *   - **Tesco, Costco, Walmart, Amazon's account tier, Shopee, Taobao** have
 *     no consumer API and no consumer OAuth. Nobody can hand you a "Sign in
 *     with Tesco" button, because Tesco does not publish one. What CAN be
 *     done is what this build does: open the retailer's own site in a real
 *     browser tab, let the human sign in there, and seal the resulting
 *     session on this machine.
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
   * Capture the `Authorization` header off requests whose URL contains this
   * string, and seal THAT rather than the cookie jar.
   *
   * Set only for real Tesco, whose basket API is a bearer-token API: its own
   * frontend calls `xapi.tesco.com` with `Authorization: Bearer <token>`, and
   * that token is exactly what the adapter needs. Reading it out of the tab
   * the shopper just signed into yields the same value the old form asked
   * them to dig out of DevTools by hand -- same source, minus the errand.
   */
  bearer?: string;
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

/**
 * The retailers a person actually shops at, none of which expose a consumer
 * API. Their catalogue rows in this build come from the bundled demo data;
 * connecting seals the real session for the adapter that will reach them.
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
 * Every store with an account, and how to reach it (S19).
 *
 * `url` is a page that answers "am I signed in?" cheaply. `loginUrl` is where
 * a signed-out shopper is taken instead. This is real automation of a real
 * login page, against Terms of Service these retailers write to prohibit
 * automated access -- including, in most of them, by the account owner's own
 * tooling. That is disclosed on the connect page itself, not buried here.
 */
const CHROME_LOGIN: Record<string, ChromeLogin> = {
  // Real Tesco (S16/S19). The signed-in state rides on an access/refresh
  // token pair its own frontend reads before calling xapi.tesco.com -- the
  // same API this build's `tsc:tesco` adapter uses for a basket, which is why
  // `bearer` is set here and nowhere else.
  "tsc:tesco": {
    url: "https://www.tesco.com/groceries/en-GB/",
    loginUrl: "https://www.tesco.com/account/login/en-GB",
    domains: ["tesco.com"],
    authCookies: ["_ttoken", "trefresh", "atrc_", "access_token"],
    bearer: "xapi.tesco.com",
  },
  "sim:tesco": {
    url: "https://www.tesco.com/groceries/en-GB/",
    loginUrl: "https://www.tesco.com/account/login/en-GB",
    domains: ["tesco.com"],
    authCookies: ["_ttoken", "trefresh", "atrc_", "access_token"],
  },
  // `at-main` is Amazon's authentication token and `sess-at-main` its signed
  // session twin; `x-main` alone only means "recognised", not "signed in".
  "sim:amazon": {
    url: "https://www.amazon.com/gp/css/homepage.html",
    loginUrl: "https://www.amazon.com/gp/sign-in.html",
    domains: ["amazon.com"],
    authCookies: ["at-main", "sess-at-main"],
  },
  // Costco runs WebSphere Commerce, which issues WC_AUTHENTICATION_<userId>
  // on sign-in and nothing resembling it before.
  "sim:costco": {
    url: "https://www.costco.com/myaccount",
    loginUrl: "https://www.costco.com/LogonForm",
    domains: ["costco.com"],
    authCookies: ["WC_AUTHENTICATION_", "C_AUTH", "costco_auth"],
  },
  // Walmart's `CID`/`customer` pair carries the signed-in customer id; the
  // anonymous session has neither.
  "sim:walmart": {
    url: "https://www.walmart.com/account",
    loginUrl: "https://www.walmart.com/account/login",
    domains: ["walmart.com"],
    authCookies: ["customer", "CID", "auth-"],
  },
  // Shopee issues SPC_ST (the signed session) and SPC_U (the user id) on
  // sign-in; an anonymous visitor gets neither.
  "sim:shopee": {
    url: "https://shopee.sg/user/account/profile",
    loginUrl: "https://shopee.sg/buyer/login",
    domains: ["shopee.sg"],
    authCookies: ["SPC_ST", "SPC_U", "SPC_R_T_ID"],
  },
  // Taobao's login mints `_l_g_` / `cookie2` / `unb` (the user number); a
  // signed-out visitor has none of the three.
  "sim:taobao": {
    url: "https://i.taobao.com/my_taobao.htm",
    loginUrl: "https://login.taobao.com/member/login.jhtml",
    domains: ["taobao.com"],
    authCookies: ["_l_g_", "unb", "cookie2", "_nk_"],
  },
  // IKEA's profile session is `idp_reference_id` plus the `ikea-` prefixed
  // pair its identity provider sets.
  "sim:ikea": {
    url: "https://www.ikea.com/gb/en/profile/login/",
    loginUrl: "https://www.ikea.com/gb/en/profile/login/",
    domains: ["ikea.com"],
    authCookies: ["idp_reference_id", "ikea-", "guest_session"],
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
  // The bearer token the capture lifts out of the signed-in tab. `token` is
  // what makes the vault's interceptor attach `Authorization: Bearer ...`,
  // which is what the Tesco basket API wants.
  methods: ["token"],
  oauth: false,
  reach:
    "Real Tesco search and product data -- no account needed for that, and it works right now. " +
    "Connect adds a real basket: a tab opens on tesco.com, you sign in on Tesco's own page, and " +
    "Basketed seals the session that produces. Tesco does not publish this as a supported " +
    "integration; using it this way is outside their Terms of Service, the same as any unofficial " +
    "API client.",
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
    reach:
      `Real ${name} search and product data -- rendered live from ${name}'s own public pages by a stealth ` +
      `browser, not a published API (${name} does not offer one). No account needed: everything this ` +
      `store returns is what any visitor sees, so there is nothing to connect.`,
    chromeLogin: null,
  };
}

const REAL_AMAZON_POLICY = realScrapePolicy("Amazon");
const REAL_IKEA_POLICY = realScrapePolicy("IKEA");
const REAL_TARGET_POLICY = realScrapePolicy("Target");

export function authPolicyFor(store: { id: string; mode: string }): StoreAuthPolicy {
  if (store.id === "tsc:tesco") return REAL_TESCO_POLICY;
  if (store.id === "amz:amazon") return REAL_AMAZON_POLICY;
  if (store.id === "ikea:ikea") return REAL_IKEA_POLICY;
  if (store.id === "tgt:target") return REAL_TARGET_POLICY;
  if (store.mode === "native") return ANONYMOUS;

  const why = NO_PUBLIC_API[store.id];
  if (why) {
    const chromeLogin = CHROME_LOGIN[store.id] ?? null;
    return {
      // One method, and it is the one the capture produces. No password
      // anywhere -- see the header comment.
      methods: chromeLogin ? ["cookie"] : [],
      oauth: false,
      reach: chromeLogin
        ? `${why} Connect opens the real site in a browser tab -- you sign in on their own page, and the ` +
          `session is sealed on this machine. That read-back is real automated access to a site whose ` +
          `Terms of Service does not permit it, including for the account owner.`
        : why,
      chromeLogin,
    };
  }

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
