import type { CapabilityTier, StoreAccount, StoreManifest } from "@basketed/core";
import type { AdapterCtx, StoreRegistry } from "@basketed/adapters";
import { authorizedFetch, SessionUnusableError, type Connection, type Vault } from "@basketed/vault";

/**
 * One place that answers "does this store need an account, and is it usable?"
 *
 * Before S21 that answer was six string literals reading `"tsc:tesco"`, in six
 * files, each with its own idea of what to do about it: commerce refused a
 * cart, the panel drew a Connect button, the MCP layer set a status, and a
 * seventh place forgot. Adding a second account store meant finding all of
 * them, and the compiler could not help.
 *
 * The adapter declares its account (`manifest.account`). Everything here is a
 * projection of that declaration and holds no store ids at all.
 */

/** A session that is present, sealed, and in date. Anything else is not. */
export type SessionState = "none" | "live" | "expired" | "broken";

/**
 * Which shelf a store belongs on in the panel.
 *
 *   fetch        no account exists here; searching signed out is the product
 *   connected    an account exists and a live session is held
 *   unconnected  an account exists and no usable session is held
 *
 * `fetch` is deliberately not "connected": a scrape store with nothing to
 * connect is not in the same state as one whose sign-in succeeded, and a panel
 * that shows both with a green tick tells a shopper their Etsy account is
 * hooked up when no such thing ever happened.
 */
export type AccountLane = "fetch" | "connected" | "unconnected";

/**
 * True when there is an account here to connect at all.
 *
 * This is the question the panel asks -- which shelf does the card go on, is
 * there a Connect button -- and it is NOT the same question as "must I sign
 * in", which is `needsAccount` below. Amazon answers yes here and no there.
 */
export function hasAccount(account: StoreAccount): boolean {
  return account.kind === "session";
}

/**
 * True when any tier of this store is GATED behind a sign-in.
 *
 * The name is the promise: somebody who does not connect cannot do the thing.
 * It has to stay narrower than `hasAccount`, because every caller of this one
 * refuses something when it is true -- and a store that merely answers better
 * signed in must not have its search refused to advertise that.
 */
export function needsAccount(account: StoreAccount): boolean {
  return account.kind === "session" && account.uses.length > 0;
}

/**
 * True when THIS tier is gated. Tesco's search is public and its trolley is
 * not, and a panel that cannot tell those apart puts a Connect wall in front
 * of the one thing that works for everybody.
 */
export function needsAccountFor(account: StoreAccount, tier: CapabilityTier): boolean {
  return account.kind === "session" && account.uses.includes(tier);
}

/**
 * True when a session would make THIS tier answer better, without being
 * required for it.
 *
 * Deliberately not part of `needsAccountFor`. Every caller of that one refuses
 * the request when it returns true, and refusing an Amazon search because
 * nobody has signed in would break the thing Basketed does best in order to
 * advertise a feature. An improved tier is never gated -- the session is
 * attached when it is there and the request goes out signed out when it is
 * not.
 */
export function improvesTier(account: StoreAccount, tier: CapabilityTier): boolean {
  return account.kind === "session" && account.improves.includes(tier);
}

function tierWord(tier: CapabilityTier): string {
  switch (tier) {
    case "cart":
      return "trolley";
    case "slots":
      return "delivery slots";
    case "discovery":
      return "search";
    case "detail":
      return "product pages";
    case "checkout":
      return "checkout";
    case "handoff":
      return "handoff";
    default:
      return tier;
  }
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** Plain English for the tiers a session unlocks: "trolley and delivery slots". */
export function usesPhrase(account: StoreAccount): string {
  if (account.kind !== "session") return "";
  return joinWords(account.uses.map(tierWord));
}

/** Plain English for the tiers a session sharpens: "search and product pages". */
export function improvesPhrase(account: StoreAccount): string {
  if (account.kind !== "session") return "";
  return joinWords(account.improves.map(tierWord));
}

export function sessionState(held: Connection | null | undefined): SessionState {
  if (!held) return "none";
  // Broken first: a credential that cannot be decrypted is dead whatever its
  // expiry says, and telling someone to wait for a refresh would be wrong.
  if (held.broken) return "broken";
  if (held.expired) return "expired";
  return "live";
}

export function laneFor(account: StoreAccount, held: Connection | null | undefined): AccountLane {
  if (!hasAccount(account)) return "fetch";
  return sessionState(held) === "live" ? "connected" : "unconnected";
}

/**
 * True when every tier this session touches works fine without it.
 *
 * The panel needs the distinction because the two read completely differently
 * to a shopper. An unconnected Tesco is a broken trolley. An unconnected
 * Amazon is a working shop that could be a better one -- and telling someone
 * their store is "not connected" in the same red-flag voice for both trains
 * them to ignore the word.
 */
export function sessionIsOptional(account: StoreAccount): boolean {
  return account.kind === "session" && account.uses.length === 0;
}

/**
 * A `fetch` for one store and one tier, carrying the shopper's session only
 * where their session is genuinely wanted.
 *
 * Three cases, and the third is the one worth writing down:
 *
 *  - the tier is GATED (`uses`): `authorizedFetch`, which refuses before the
 *    request when the session is expired or broken. That refusal is the
 *    point; a signed-out Tesco basket page has the right shape and reads as
 *    an empty trolley.
 *  - the tier is IMPROVED (`improves`) and a live session is held: attach it.
 *  - the tier is IMPROVED and the session is missing, expired or broken:
 *    **go out anonymously**. Signed-out Amazon search is the product working,
 *    not the product failing, and an expiry nobody has got round to fixing
 *    must never be the reason a search returns nothing. It is logged, once,
 *    so the degradation is visible rather than silent.
 *
 * A session that expires between the check and the call still throws inside
 * `authorizedFetch`; on an improved tier that is caught here and retried
 * signed out, because losing the search to a race would be the same bug with
 * a smaller window.
 */
export function sessionFetchFor(
  manifest: StoreManifest,
  tier: CapabilityTier,
  vault: Vault | undefined,
  base: typeof fetch,
  log?: (msg: string) => void,
): typeof fetch {
  const account = manifest.account;
  if (!vault || account.kind !== "session") return base;

  if (account.uses.includes(tier)) return authorizedFetch(vault, manifest.id, base);
  if (!account.improves.includes(tier)) return base;

  let warned = false;
  return async (input, init) => {
    const state = sessionState(vault.get(manifest.id));
    if (state !== "live") {
      if (!warned && state !== "none") {
        warned = true;
        log?.(`${manifest.id}: ${sessionUnusableReason(vault.get(manifest.id))}; asking ${tier} signed out.`);
      }
      return base(input, init);
    }
    try {
      return await authorizedFetch(vault, manifest.id, base)(input, init);
    } catch (err) {
      if (!(err instanceof SessionUnusableError)) throw err;
      log?.(`${manifest.id}: session became unusable mid-request; asking ${tier} signed out.`);
      return base(input, init);
    }
  };
}

/**
 * The per-store context factory search and detail hand to an adapter.
 *
 * Until S22 both paths used one shared `ctx` built from bare `fetch`, so a
 * connected session reached the cart and the slot list and nothing else. That
 * made "connect this store" a promise about one API call, which is why only
 * the one store with a gated cart had anything to connect.
 */
export function ctxFactory(
  registry: StoreRegistry,
  base: AdapterCtx,
  vault: Vault | undefined,
  tier: CapabilityTier,
): (storeId: string) => { ctx: AdapterCtx; tag: string } {
  return (storeId) => {
    const adapter = registry.get(storeId);
    if (!adapter) return { ctx: base, tag: "anon" };
    const http = sessionFetchFor(adapter.manifest, tier, vault, base.http, base.log);
    // The tag says what the ANSWER will be, not what the wiring is: a store
    // with a session block whose session has expired fetches signed out, and
    // must not share a cache entry with the same store once it is reconnected.
    const live = adapter.manifest.account.kind === "session" && sessionState(vault?.get(storeId)) === "live";
    return { ctx: http === base.http ? base : { ...base, http }, tag: live ? "auth" : "anon" };
  };
}

/** Why a held session cannot be used, in the words a shopper needs. Null when it can. */
export function sessionUnusableReason(held: Connection | null | undefined): string | null {
  switch (sessionState(held)) {
    case "live":
      return null;
    case "expired":
      return "the connected session has expired";
    case "broken":
      return "the stored credential cannot be read";
    default:
      return "no account is connected";
  }
}

/**
 * What to tell someone who asked for a gated tier without a usable session.
 *
 * Says the store, what is missing, what it would unlock and where the button
 * is. A raw 401 from a retailer reads like a network fault, and the agent
 * relaying it has no way to know it was a sign-in problem.
 */
export function connectHint(manifest: StoreManifest, held: Connection | null | undefined): string {
  const why = sessionUnusableReason(held) ?? "no account is connected";
  const what = usesPhrase(manifest.account);
  const where = manifest.account.kind === "session" ? manifest.account.login.domains[0] : manifest.domain;
  return (
    `${manifest.name} ${what || "this action"} needs a connected session (${why}). ` +
    `Open the Basketed panel → Connect stores → ${manifest.name}, press Connect, ` +
    `sign in on ${where ?? "the retailer site"} if asked.`
  );
}

/**
 * Push what the vault holds into the registry's status, for every account
 * store there is.
 *
 * The old version was `syncTescoStatus`, hard-coded to one id and duplicated
 * between the panel and the MCP runtime. A second account store would have
 * been registered `ready` forever, whatever the vault said.
 *
 * Stores with no account are left alone: their status is about whether the
 * adapter loaded, and a vault has nothing to say about that.
 */
export function syncAccountStatus(registry: StoreRegistry, vault: Vault | undefined, storeId?: string): void {
  const adapters = storeId
    ? [registry.get(storeId)].filter((a): a is NonNullable<typeof a> => Boolean(a))
    : registry.all();
  for (const adapter of adapters) {
    /*
     * Only a GATED store can be `needs_auth`.
     *
     * Status answers "can this store serve a request", and a store whose
     * session merely sharpens the answer can: it searches signed out and
     * always could. Flagging those `needs_auth` would drop them out of
     * `list({ connectedOnly })` and hang a warning off eleven working shops
     * for a sign-in none of them require.
     */
    if (!needsAccount(adapter.manifest.account)) continue;
    const held = vault?.get(adapter.manifest.id) ?? null;
    registry.setStatus(adapter.manifest.id, sessionState(held) === "live" ? "ready" : "needs_auth");
  }
}
