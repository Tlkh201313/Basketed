import { z } from "zod";
import { MoneySchema } from "./money.js";

/**
 * A delivery window.
 *
 * Its own capability tier rather than part of `cart`, because the two are
 * genuinely separable: a grocer will hold a basket with no slot and a slot
 * with no basket, and a store can support one without the other. Both
 * groceries MCPs studied for this (GavinAttard/tesco-grocery-mcp and
 * tomaspavlin/rohlik-mcp, both MIT) model slots as a separate surface for the
 * same reason -- which is also the evidence that this is a tier and not a
 * Tesco feature.
 *
 * Times are ISO 8601 WITH an offset, never a local wall-clock string. A
 * delivery window is the one field in this codebase where an ambiguous hour is
 * a missed doorstep.
 */
export const DeliverySlotSchema = z.object({
  id: z.string().min(1),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  available: z.boolean(),
  /** Null when the retailer does not price windows separately. */
  price: MoneySchema.nullable(),
});
export type DeliverySlot = z.infer<typeof DeliverySlotSchema>;

/**
 * A window the shopper now holds.
 *
 * Booking is a commitment against a real account, which is why it is an
 * approval-gated operation and never reachable under fast-mode.
 */
export const BookedSlotSchema = z.object({
  slotId: z.string().min(1),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  /** When the retailer releases an unpaid reservation, if it says so at all. */
  expiresAt: z.string().datetime({ offset: true }).nullable(),
});
export type BookedSlot = z.infer<typeof BookedSlotSchema>;
