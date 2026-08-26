import { createHash } from "node:crypto";
import type { Money } from "@basketed/core";

/**
 * The Cart Mandate (§6, §10).
 *
 * The vocabulary is Google's AP2, donated to the FIDO Alliance in May 2026:
 * an **Intent Mandate** carries the user's standing rules (caps, allowed
 * stores, allowed addresses) and a **Cart Mandate** freezes exact items,
 * prices, taxes and shipping at approval time. Using their words makes this
 * standards alignment instead of a proprietary one-off.
 *
 * The mandate is what the human approves and what the server re-checks at
 * execution. If anything in it moved, the approval is void.
 */

export interface MandateLine {
  id: string;
  variantId: string;
  name: string;
  quantity: number;
  unitPrice: Money;
}

export interface CartMandate {
  storeId: string;
  accountHandle: string;
  cartId: string | null;
  lineItems: MandateLine[];
  adjustments: Array<{ type: string; amount: Money; label: string }>;
  subtotal: Money;
  total: Money;
  /** Present only when a real hand-off URL exists. Never a search link. */
  handoffUrl: string | null;
  routeRung: 1 | 2 | 3 | 4;
  /** Set on simulated stores so the stamp survives into the approval record. */
  mode: string;
  addressId?: string;
  slot?: string;
}

/**
 * Canonical JSON: keys sorted, floats fixed to 2dp, nothing else included.
 *
 * Note what is NOT in here: descriptions, review text, merchant messages, any
 * free-form vendor string. The hash covers only numeric and enumerated fields
 * plus the normalized product name -- so no injected text can change the hash
 * or reach the approval screen. That is the actual defence against
 * injection-steered purchases; sanitisation is defence in depth.
 */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function cartHash(mandate: CartMandate): string {
  const material = {
    store: mandate.storeId,
    account_handle: mandate.accountHandle,
    line_items: mandate.lineItems
      .map((li) => ({
        sku: li.variantId,
        name: li.name,
        qty: li.quantity,
        unit_price: { value: li.unitPrice.value, currency: li.unitPrice.currency },
      }))
      // Sorted so an upstream reordering of identical lines is not treated as
      // drift, while any change to a price, quantity or sku still is.
      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)),
    adjustments: mandate.adjustments
      .map((a) => ({ type: a.type, value: a.amount.value, currency: a.amount.currency }))
      .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)),
    total: { value: mandate.total.value, currency: mandate.total.currency },
    address_id: mandate.addressId ?? null,
    slot: mandate.slot ?? null,
  };
  return createHash("sha256").update(canonical(material)).digest("hex");
}

/**
 * The human-facing summary, built ONLY from the mandate.
 *
 * This is the string printed on the server console and rendered in the panel.
 * It is assembled from numbers, enumerated fields and the normalized product
 * name -- never from a description, a review or a merchant message -- so there
 * is no vendor-controlled text on the approval surface at all.
 */
export function describeMandate(mandate: CartMandate): string[] {
  const money = (m: Money) => `${m.value.toFixed(2)} ${m.currency}`;
  const lines = mandate.lineItems.map(
    (li) => `${li.quantity} x ${li.name}  @ ${money(li.unitPrice)}`,
  );
  for (const adj of mandate.adjustments) lines.push(`${adj.label}: ${money(adj.amount)}`);
  return lines;
}
