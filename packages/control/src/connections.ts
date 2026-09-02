import type { AccountLogin, StoreAccount } from "@basketed/core";
import type { CredentialKind } from "@basketed/vault";
import { improvesPhrase, sessionIsOptional, usesPhrase } from "@basketed/commerce";

/**
 * What connecting a store actually means, rendered for the panel.
 *
 * Until S21 this file held the answer: a table keyed by store id, saying
 * which stores had a Connect button, where it sent you, and which cookies to
 * watch for. It was the only place that knew Tesco has a trolley behind a
 * sign-in and Etsy does not, so the panel could offer Connect for a store
 * whose adapter never reads a session and nothing would catch it.
 *
 * The adapter declares that now, in `manifest.account`. This file is a
 * projection of the declaration into panel copy, and holds no store ids.
 *
 * The three situations one identical "Connect" button would have lied about
 * are still three, they are just no longer written down here:
 *
 *   - **Shopify UCP merchants** need nothing. Their agentic endpoint is
 *     anonymous; there is no account to connect and adding a login step would
 *     invent one that does not exist. (`account: none`)
 *   - **Amazon, Target, Best Buy, eBay, Etsy and IKEA** are reached through
 *     their own public pages and search perfectly well signed out. They also
 *     answer noticeably better signed in -- the shopper's own address, their
 *     store's stock, their delivery estimate, and a request that is turned
 *     away as a robot far less often -- so a session is offered and never
 *     required. (`account: session`, `uses: []`)
 *   - **Tesco** search is public; the basket is not. Connect opens tesco.com,
 *     the human signs in there, and Basketed lifts `authorization` plus
 *     `customer-uuid` from Tesco's own `xapi.tesco.com` call (the same pair
 *     GavinAttard/tesco-grocery-mcp sends, captured instead of pasted).
 *     (`account: session`)
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

/**
 * Where "Connect" sends a human, and what to read back afterwards.
 *
 * The shape now lives in the core schema so an adapter can declare it. This
 * alias is kept because the browser-connect session machinery reads it by
 * this name in a dozen places, and renaming those buys nothing.
 */
export type ChromeLogin = AccountLogin;

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

/**
 * True when every header the store asked for has actually arrived.
 *
 * The check this replaces read `headers.every((h) => captured[h.toLowerCase()])`
 * against the raw capture, which does not know that `customer-uuid` and
 * `x-customer-uuid` are the same header. Tesco sends one or the other
 * depending on the route, so a session that was complete could be reported as
 * still waiting, leaving a human staring at a tab that would never finish.
 */
export function captureComplete(
  capture: { headers: string[] } | null | undefined,
  captured: Record<string, string>,
): boolean {
  if (!capture) return false;
  return capture.headers.every((name) =>
    sessionHeaderAliases(name).some((alias) => String(captured[alias] ?? "").trim() !== ""),
  );
}

/**
 * The panel's view of one store's account, derived entirely from what the
 * adapter declared.
 *
 * `mode` is still consulted for the copy on a store with no account, because
 * "demo catalogue" and "live store, no sign-in needed" read differently to a
 * shopper even though both are `account: none` as far as the code cares.
 */
export function authPolicyFor(store: { name: string; mode: string; account: StoreAccount }): StoreAuthPolicy {
  const account = store.account;

  if (account.kind === "session") {
    const domain = account.login.domains[0] ?? "the retailer site";
    const how =
      `A tab opens on ${domain}, you sign in there, and Basketed seals the session. ` +
      `No password is typed into Basketed.`;

    // A store whose session only sharpens the answer must not be described in
    // the words of one whose trolley is locked. "Connect to use your real
    // trolley" on Amazon would be a promise about a cart this adapter does not
    // have; "connect for better answers" on Tesco would undersell a basket
    // that genuinely does not exist without it.
    if (sessionIsOptional(account)) {
      return {
        methods: ["session"],
        oauth: false,
        reach:
          `${store.name} ${improvesPhrase(account)} work signed out. Connect to get the prices, ` +
          `stock and delivery your own account sees — and to be turned away as a robot far less ` +
          `often. ${how}`,
        chromeLogin: account.login,
      };
    }

    return {
      methods: ["session"],
      oauth: false,
      reach:
        `Search ${store.name} without an account. Connect to use your real ${usesPhrase(account)}: ${how}`,
      chromeLogin: account.login,
    };
  }

  if (account.kind === "demo") {
    return {
      methods: [],
      oauth: false,
      reach: "Demo catalogue. Search works offline; there is no real account to connect.",
      chromeLogin: null,
    };
  }

  // No account. Which of the two true sentences to show depends on where the
  // data comes from, not on whether there is a credential -- there is not.
  if (store.mode === "native") {
    return {
      methods: [],
      oauth: false,
      reach: `Live ${store.name} search from their public pages. No account needed.`,
      chromeLogin: null,
    };
  }
  return {
    methods: [],
    oauth: false,
    reach: "Nothing to connect: this store needs no account.",
    chromeLogin: null,
  };
}

export function methodLabel(method: ConnectMethod): string {
  return method === "cookie"
    ? "Browser session"
    : method === "session"
      ? "Browser session"
      : method === "token"
        ? "Access token"
        : "Account";
}
