import type { Db } from "./db.js";

/**
 * Shopping mode (S24).
 *
 * Two ways Basketed can end a shopping task, and a person picks one in the
 * panel:
 *
 *   - **basket** -- the agent puts what it found into YOUR OWN basket at the
 *     store, in the account you connected, and reports back with a link. You
 *     open the basket, look at it, and finish checkout yourself on the
 *     retailer's own page. No approval codes, no mandate, no payment step
 *     inside Basketed at all.
 *   - **purchase** -- the S5/S6 gate: a Cart Mandate, a human-typed total or a
 *     console code, then a checkout handoff. Every guardrail applies.
 *
 * Today only basket mode is available. Purchase mode is shown in the panel
 * greyed out and cannot be selected; the save path below refuses it, and the
 * purchase gate in `purchase.ts` refuses to prepare or confirm a cart while
 * the mode is anything else. That is a PRODUCT lock, not a security boundary:
 * the human-approval gates inside purchase mode stand on their own and do not
 * get any weaker when the mode is eventually unlocked.
 */

export type ShoppingMode = "basket" | "purchase";

export interface ShoppingModeOption {
  id: ShoppingMode;
  label: string;
  description: string;
  /** False while a mode is locked in this build. The panel greys it out. */
  available: boolean;
  lockedReason?: string;
}

export const SHOPPING_MODES: readonly ShoppingModeOption[] = [
  {
    id: "basket",
    label: "Basket mode",
    description:
      "Your agent finds the best match and adds it to your own basket at the store, in the account you " +
      "connected. You get a link, open the basket, and check out yourself. Nothing is bought by Basketed.",
    available: true,
  },
  {
    id: "purchase",
    label: "Purchase mode",
    description:
      "Your agent prepares a cart, you approve the exact total in this panel, and Basketed hands you to the " +
      "merchant's checkout. Guardrails and single-use approvals apply.",
    available: false,
    lockedReason: "Locked in this build. Purchase mode is coming later; basket mode is on.",
  },
];

export const DEFAULT_SHOPPING_MODE: ShoppingMode = "basket";

const MODE_KEY = "shopping_mode";

/** A refused mode write, in words the panel can show a person. */
export class ShoppingModeError extends Error {
  constructor(
    message: string,
    /** True when the mode exists but is locked in this build. */
    public readonly locked = false,
  ) {
    super(message);
  }
}

export function optionFor(mode: string): ShoppingModeOption | undefined {
  return SHOPPING_MODES.find((m) => m.id === mode);
}

/**
 * The mode in force. Anything the database holds that is not a known mode
 * reads as the default, so a hand-edited row cannot put the gate into a state
 * the code has no name for.
 */
export function loadShoppingMode(db: Db): ShoppingMode {
  const row = db.prepare("SELECT v FROM settings WHERE k = ?").get(MODE_KEY) as { v: string } | undefined;
  const opt = row ? optionFor(row.v) : undefined;
  return opt ? opt.id : DEFAULT_SHOPPING_MODE;
}

/**
 * The only write path the panel uses. A locked mode is refused here, before
 * anything is written, and the refusal says it is a lock rather than a typo.
 */
export function saveShoppingMode(db: Db, mode: string): ShoppingMode {
  const opt = optionFor(mode);
  if (!opt) {
    throw new ShoppingModeError(`Unknown shopping mode "${mode}". Choose ${SHOPPING_MODES.map((m) => m.id).join(" or ")}.`);
  }
  if (!opt.available) {
    throw new ShoppingModeError(`${opt.label} is not available: ${opt.lockedReason ?? "locked in this build."}`, true);
  }
  db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(MODE_KEY, opt.id);
  return opt.id;
}

/** What the panel renders: the mode in force plus every option, locked ones included. */
export function describeShoppingModes(db: Db): {
  mode: ShoppingMode;
  options: Array<{ id: ShoppingMode; label: string; description: string; available: boolean; locked_reason?: string }>;
} {
  return {
    mode: loadShoppingMode(db),
    options: SHOPPING_MODES.map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      available: m.available,
      ...(m.lockedReason ? { locked_reason: m.lockedReason } : {}),
    })),
  };
}

/** The sentence the purchase gate gives back while purchase mode is not the mode in force. */
export function purchaseLockedMessage(mode: ShoppingMode): string {
  const purchase = optionFor("purchase");
  const why = purchase && !purchase.available ? ` ${purchase.lockedReason}` : "";
  return (
    `Basketed is in ${optionFor(mode)?.label.toLowerCase() ?? mode}: nothing is prepared for approval or bought here. ` +
    `Add the items to the shopper's own basket with basket_add_to_cart and tell them where to find it; they check out themselves.${why}`
  );
}
