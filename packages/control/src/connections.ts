import type { CredentialKind } from "@basketed/vault";
import { loginFor, type StoreLogin } from "@basketed/session";

/**
 * What connecting a store actually means, per store (S14, rewritten S19, S23).
 *
 * This table exists because the honest answer differs by retailer, and a
 * panel that rendered one identical "Connect" button for all of them would be
 * lying about three different situations at once:
 *
 *   - **Shopify UCP merchants** need nothing. Their agentic endpoint is
 *     anonymous; there is no account to connect and adding a login step would
 *     invent one that does not exist.
 *   - **The seven real retailers** -- Tesco, Amazon, IKEA, Target, Etsy, eBay,
 *     Best Buy -- are searched signed-out through their own public pages or
 *     API. That works today with no account. A basket, a checkout handoff
 *     that lands in YOUR account: those need the store to know who you are,
 *     and none of these retailers publishes a consumer API or OAuth flow for
 *     it. So Connect does the one thing that is real: it signs you in at the
 *     retailer's own page, in a browser profile Basketed keeps for that store,
 *     and keeps that profile signed in.
 *   - **The simulated twins** (`sim:*`) show demo catalogue data but connect
 *     to the same real retailer, so the offline drill has something to sign
 *     into.
 *
 * ## Where the password goes (S23)
 *
 * S19 removed every password box from this panel, and the reason stands: a
 * retailer password typed into someone else's form is the shape of every
 * phishing page ever built. Connect still asks you to sign in on the
 * retailer's own page, at the real URL, with the padlock you can check.
 *
 * What S23 adds is OPTIONAL: you may leave a store's email and password with
 * Basketed, sealed like every other credential, so that when a session goes
 * stale weeks later the profile can re-sign-in by itself instead of waiting
 * for you. That password is typed by Basketed into exactly one place -- the
 * retailer's own sign-in form, on the retailer's own host (checked before a
 * keystroke), inside the profile that belongs to that store -- and nowhere
 * else, ever. If the retailer then asks for a code or a captcha, Basketed
 * stops and says "needs you" in the panel. It never guesses, never bypasses,
 * never opens a window when nobody is there.
 *
 * `reach` is the sentence the card shows under the store name.
 */

export type ConnectMethod = CredentialKind;

export interface StoreAuthPolicy {
  /** Empty when there is nothing to connect. Never contains "password": that is a separate, optional row. */
  methods: ConnectMethod[];
  /** True once a retailer publishes a real consumer OAuth flow. None do today. */
  oauth: boolean;
  /** One line, shown on the card. Says what a connection here can actually do. */
  reach: string;
  /** Set for every store that has an account to sign in to. */
  login: StoreLogin | null;
}

const ANONYMOUS: StoreAuthPolicy = {
  methods: [],
  oauth: false,
  reach: "Anonymous. This merchant's agentic endpoint needs no account, so there is nothing to connect.",
  login: null,
};

const TOS =
  "That is real automated access to a site whose Terms of Service does not permit it, including for the account owner.";

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
 * Real Tesco (S16). `mode: "native"` because search/detail genuinely are --
 * Tesco's own live API, no auth needed. That is also why it cannot fall
 * through to the generic `mode === "native"` case below: unlike Shopify UCP,
 * this store's basket DOES need a credential, so "native" here is not a
 * synonym for "nothing to connect".
 */
const REAL_TESCO_POLICY: StoreAuthPolicy = {
  // The signed-in cookie jar. Tesco's basket lives behind the site's own
  // cookie-authenticated endpoints; the bearer its page embeds is rejected
  // by xapi.tesco.com for `basket` (see the session descriptor).
  methods: ["cookie"],
  oauth: false,
  reach:
    "Real Tesco search and product data -- no account needed for that, and it works right now. " +
    "Connect adds a real basket: you sign in once on tesco.com in a window Basketed keeps for Tesco, " +
    "and it stays signed in from then on. Tesco does not publish this as a supported integration; " +
    "using it this way is outside their Terms of Service, the same as any unofficial API client.",
  login: loginFor("tsc:tesco"),
};

/**
 * Real Amazon, IKEA, Target, Etsy, eBay, Best Buy (S17, S21, S23). Search and
 * detail are the retailer's own public pages, rendered by a stealth browser
 * and read as a signed-out visitor sees them -- no account needed, and the
 * card says so first. Connect is for the part a visitor cannot do: a basket
 * and a checkout that land in YOUR account.
 */
function realStorePolicy(id: string, name: string, how: string): StoreAuthPolicy {
  return {
    methods: ["cookie"],
    oauth: false,
    reach:
      `Real ${name} search and product data -- no account needed for that, ${how}. ` +
      `Connect signs you in once on ${name}'s own page, in a window Basketed keeps for ${name}, and keeps ` +
      `that profile signed in so a basket and checkout land in your account. ${TOS}`,
    login: loginFor(id),
  };
}

const REAL_POLICIES: Record<string, StoreAuthPolicy> = {
  "tsc:tesco": REAL_TESCO_POLICY,
  "amz:amazon": realStorePolicy("amz:amazon", "Amazon", "rendered live from Amazon's public pages (Amazon offers no consumer API)"),
  "ikea:ikea": realStorePolicy("ikea:ikea", "IKEA", "rendered live from IKEA's public pages (IKEA offers no public API)"),
  "tgt:target": realStorePolicy("tgt:target", "Target", "rendered live from Target's public pages (Target offers no consumer API)"),
  "etsy:etsy": realStorePolicy("etsy:etsy", "Etsy", "read live from Etsy's public listings (Etsy's API is for sellers)"),
  "ebay:ebay": realStorePolicy("ebay:ebay", "eBay", "read live from eBay's public listings"),
  "bby:bestbuy": realStorePolicy("bby:bestbuy", "Best Buy", "rendered live from Best Buy's public pages"),
};

export function authPolicyFor(store: { id: string; mode: string }): StoreAuthPolicy {
  const real = REAL_POLICIES[store.id];
  if (real) return real;
  if (store.mode === "native") return ANONYMOUS;

  const why = NO_PUBLIC_API[store.id];
  if (why) {
    const login = loginFor(store.id);
    return {
      // One method, and it is the one the sign-in produces.
      methods: login ? ["cookie"] : [],
      oauth: false,
      reach: login
        ? `${why} Connect signs you in once on the real site, in a window Basketed keeps for it, and the ` +
          `session is sealed on this machine. ${TOS}`
        : why,
      login,
    };
  }

  return {
    methods: [],
    oauth: false,
    reach: "Nothing to connect: this store needs no account.",
    login: null,
  };
}

/** The label the panel puts on a held credential. */
export function secretLabel(method: ConnectMethod): string {
  return method === "cookie" ? "Session" : method === "token" ? "Access token" : "Account";
}

export function methodLabel(method: ConnectMethod): string {
  return method === "cookie" ? "Browser session" : method === "token" ? "Access token" : "Account";
}

/* ------------------------------------------------------------- brands (S23) */

export interface StoreRow {
  id: string;
  name: string;
  mode: string;
  country?: string;
  currency?: string;
}

/**
 * One brand, however many registry rows carry it.
 *
 * Amazon, Tesco and IKEA each appear twice in the registry, and the reason is
 * real: one row is the retailer's own live data, the other a fixture set the
 * offline drill depends on. They are different stores with different
 * capabilities, so the registry rightly refuses to merge them. The PANEL can
 * merge them, because a shopper connects to Tesco, not to `tsc:tesco`: one
 * card, two mode chips, and Connect belongs to the row that actually reaches
 * the retailer -- live when there is one, the sample twin otherwise.
 */
export interface BrandGroup {
  brandKey: string;
  name: string;
  live: StoreRow | null;
  sample: StoreRow | null;
  /** Rows that are neither `native` nor `simulated`, kept visible rather than dropped. */
  others: StoreRow[];
  primary: StoreRow;
  ids: string[];
}

export function brandKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

export function groupByBrand(stores: StoreRow[]): BrandGroup[] {
  const byBrand = new Map<string, StoreRow[]>();
  for (const s of stores) {
    const key = brandKeyOf(s.name);
    byBrand.set(key, [...(byBrand.get(key) ?? []), s]);
  }
  const groups: BrandGroup[] = [];
  for (const [brandKey, rows] of byBrand) {
    const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
    const live = sorted.find((s) => s.mode === "native") ?? null;
    const sample = sorted.find((s) => s.mode === "simulated") ?? null;
    const others = sorted.filter((s) => s !== live && s !== sample);
    const primary = live ?? sample ?? (others[0] as StoreRow);
    groups.push({ brandKey, name: primary.name, live, sample, others, primary, ids: sorted.map((s) => s.id) });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

/** The brand a store id belongs to, or null if the id is not in the list. */
export function brandOf(stores: StoreRow[], id: string): BrandGroup | null {
  return groupByBrand(stores).find((g) => g.ids.includes(id)) ?? null;
}
