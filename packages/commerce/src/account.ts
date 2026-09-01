import type { CapabilityTier, StoreAccount, StoreManifest } from "@basketed/core";
import type { StoreRegistry } from "@basketed/adapters";
import type { Connection, Vault } from "@basketed/vault";

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

/** True when any tier of this store is gated behind a sign-in. */
export function needsAccount(account: StoreAccount): boolean {
  return account.kind === "session";
}

/**
 * True when THIS tier is gated. Tesco's search is public and its trolley is
 * not, and a panel that cannot tell those apart puts a Connect wall in front
 * of the one thing that works for everybody.
 */
export function needsAccountFor(account: StoreAccount, tier: CapabilityTier): boolean {
  return account.kind === "session" && account.uses.includes(tier);
}

/** Plain English for the tiers a session unlocks: "trolley and delivery slots". */
export function usesPhrase(account: StoreAccount): string {
  if (account.kind !== "session") return "";
  const words = account.uses.map((tier) =>
    tier === "cart"
      ? "trolley"
      : tier === "slots"
        ? "delivery slots"
        : tier === "checkout"
          ? "checkout"
          : tier === "handoff"
            ? "handoff"
            : tier,
  );
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
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
  if (!needsAccount(account)) return "fetch";
  return sessionState(held) === "live" ? "connected" : "unconnected";
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
    if (!needsAccount(adapter.manifest.account)) continue;
    const held = vault?.get(adapter.manifest.id) ?? null;
    registry.setStatus(adapter.manifest.id, sessionState(held) === "live" ? "ready" : "needs_auth");
  }
}
