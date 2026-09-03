import { randomBytes } from "node:crypto";
import type { Money } from "@basketed/core";
import type { Db } from "./db.js";
import { describeMandate, type CartMandate, type MandateLine } from "./mandate.js";
import {
  audit,
  cartContextFor,
  cartStoreFor,
  money,
  resolveRoute,
  withRetryCart,
  type PurchaseDeps,
} from "./purchase.js";

/**
 * Basket mode (S24): put it in THEIR basket and say where it is.
 *
 * This is the whole of what the agent can do to an account in basket mode.
 * It builds a real cart at one store, in the account the person connected,
 * records what it put there, and reports back with the link to the basket.
 * There is no approval, no mandate, no code and no checkout handoff, because
 * nothing here can move money: the person opens their own basket on the
 * retailer's own page and pays there, or does not.
 *
 * Available in every mode -- a purchase-mode user can still ask for a basket
 * -- and it is the ONLY money-adjacent path open while purchase mode is locked.
 */

export interface BasketInput {
  items: Array<{ id: string; quantity: number }>;
  accountHandle: string;
  /** Derived from the verified local session by the caller. Never from the agent. */
  principal: string;
}

export interface BasketResult {
  basketId: string;
  storeId: string;
  storeName: string;
  /** `simulated` on a demo twin: no real basket exists behind it and the report says so. */
  mode: string;
  lineItems: MandateLine[];
  adjustments: CartMandate["adjustments"];
  subtotal: Money;
  total: Money;
  /** Where the person opens their basket. Null on a simulated store. */
  basketUrl: string | null;
  summary: string[];
  /** What the agent should tell the person, in one paragraph. */
  report: string;
}

function mintBasketId(): string {
  return `bsk_${randomBytes(12).toString("base64url")}`;
}

export async function addToBasket(deps: PurchaseDeps, input: BasketInput): Promise<BasketResult> {
  const now = deps.now?.() ?? Date.now();
  const { storeId, adapter } = cartStoreFor(deps, input.items);
  const cartCtx = cartContextFor(deps, storeId, adapter);
  const raw = await withRetryCart(() => adapter.buildCart(input.items, cartCtx));

  const lineItems: MandateLine[] = raw.lineItems.map((li) => ({
    id: li.id,
    variantId: li.variantId,
    name: li.name,
    quantity: li.quantity,
    unitPrice: li.unitPrice,
  }));
  const simulated = adapter.manifest.mode === "simulated";
  const route = resolveRoute(raw.handoffUrl, adapter.manifest.mode, adapter.manifest.name, adapter.manifest.domain);
  // Only a URL that reaches a real basket is offered. A product deep link or a
  // bare homepage is not "your basket", and saying so would send the person
  // looking for items that are not there.
  const basketUrl = !simulated && route.rung === 1 ? route.url : null;

  const record: CartMandate = {
    storeId,
    accountHandle: input.accountHandle,
    cartId: raw.cartId,
    lineItems,
    adjustments: raw.adjustments,
    subtotal: raw.subtotal,
    total: raw.total,
    handoffUrl: raw.handoffUrl,
    routeRung: route.rung,
    mode: adapter.manifest.mode,
  };

  const id = mintBasketId();
  deps.db
    .prepare(
      `INSERT INTO baskets
         (id, principal, store_id, account_handle, cart_id, cart_json, total_value, total_currency, cart_url, mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.principal,
      storeId,
      input.accountHandle,
      raw.cartId,
      JSON.stringify(record),
      raw.total.value,
      raw.total.currency,
      basketUrl,
      adapter.manifest.mode,
      now,
    );
  audit(deps.db, "basket_filled", `${id} ${storeId} ${money(raw.total)}`, now);

  const summary = describeMandate(record);
  const name = adapter.manifest.name;
  const report = simulated
    ? `SIMULATED ${name}: this is demo catalogue data, so no real basket exists and nothing was added anywhere. ` +
      `In a live store the same call would add ${summary.length} line(s) totalling ${money(raw.total)} to the shopper's own basket.`
    : basketUrl
      ? `Added to the shopper's own ${name} basket, in the account they connected: ${summary.join("; ")}. ` +
        `Basket total ${money(raw.total)}. They open ${basketUrl} to review it and check out themselves. ` +
        `Basketed has not bought anything and will not.`
      : `Added to the shopper's own ${name} basket (${summary.join("; ")}, total ${money(raw.total)}), but ${name} ` +
        `gave no basket link back. Tell them to open their basket on ${name}'s site to review it and check out themselves.`;

  deps.announce([
    "",
    `-------------------- BASKETED -- added to your ${name} basket${simulated ? "  [SIMULATED]" : ""} --------------------`,
    ...summary.map((s) => `    ${s}`),
    `  TOTAL   ${money(raw.total)}`,
    basketUrl ? `  Open it: ${basketUrl}` : "  Open your basket on the store's own site to review it.",
    "  Nothing has been bought. You check out yourself.",
    "",
  ]);

  return {
    basketId: id,
    storeId,
    storeName: name,
    mode: adapter.manifest.mode,
    lineItems,
    adjustments: raw.adjustments,
    subtotal: raw.subtotal,
    total: raw.total,
    basketUrl,
    summary,
    report,
  };
}

/** Recent baskets, newest first, without the account handle or the raw cart. */
export function listBaskets(db: Db, limit = 20): Array<Record<string, unknown>> {
  const rows = db
    .prepare(
      `SELECT id, store_id, mode, total_value, total_currency, cart_url, cart_json, created_at
         FROM baskets ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(({ cart_json, ...rest }) => {
    const parsed = JSON.parse(String(cart_json)) as CartMandate;
    return { ...rest, line_items: parsed.lineItems, summary: describeMandate(parsed) };
  });
}
