import type { BookedSlot, DeliverySlot } from "@basketed/core";

/**
 * Tesco delivery slots.
 *
 * The operation names, the variables and the `SlotActions` enum were learned
 * from GavinAttard/tesco-grocery-mcp (MIT), which drives the same
 * `xapi.tesco.com` GraphQL endpoint this adapter already uses for detail and
 * basket. Two details from that source are worth naming, because guessing
 * either produces a call Tesco answers with nothing useful:
 *
 *   - Slots come back from `delivery`, and the id field is `id`. `charge` is a
 *     bare number, not a money object -- the currency is the store's.
 *   - Booking is not a `bookSlot` mutation. It is `fulfilment(slotId, action)`
 *     with `action: BOOK`, and the same operation releases one with `UNBOOK`.
 *
 * `extensions.mfeName` goes out because tesco.com's own frontend sends it:
 * the gateway routes on it, and an operation without it is not the request
 * the site makes.
 *
 * The query bodies are narrower than the reference's, deliberately. Every
 * field asked for is a field that can change shape underneath us, and
 * `basket_get_token_report` counts every byte Tesco sends back.
 */
export const DELIVERY_SLOTS_QUERY = `query DeliverySlots($start: String, $end: String, $type: FulfilmentTypeType) {
  delivery(start: $start, end: $end) {
    id
    start
    end
    status
    charge
  }
  fulfilment(type: $type, range: {start: $start, end: $end}) {
    metadata { preBookedOrderDays }
  }
}`;

export const FULFILMENT_MUTATION = `mutation Fulfilment($slotId: ID, $action: SlotActions) {
  fulfilment(slotId: $slotId, action: $action) {
    slot {
      id
      status
      start
      end
      reservationExpiry
    }
  }
}`;

/** The micro-frontend Tesco's own slots page identifies itself as. */
export const SLOTS_MFE = "mfe-slots";

interface RawSlot {
  id?: unknown;
  start?: unknown;
  end?: unknown;
  status?: unknown;
  charge?: unknown;
}

/** Tesco spells it "Available"; the reference compares exactly. We do not. */
function isAvailable(status: unknown): boolean {
  return typeof status === "string" && status.toLowerCase() === "available";
}

/**
 * A slot with no id cannot be booked, so it is not a slot -- dropping it beats
 * handing the model something it can only fail with.
 *
 * `charge` is a number and zero is a real price, so the null test is on the
 * TYPE, not on truthiness: a free delivery window is free, not unpriced.
 */
export function flattenSlots(raw: RawSlot[], currency: string, includeUnavailable: boolean): DeliverySlot[] {
  const out: DeliverySlot[] = [];
  for (const s of raw) {
    const id = typeof s.id === "string" ? s.id : null;
    const start = typeof s.start === "string" ? s.start : null;
    const end = typeof s.end === "string" ? s.end : null;
    if (!id || !start || !end) continue;
    const available = isAvailable(s.status);
    if (!available && !includeUnavailable) continue;
    out.push({
      id,
      start,
      end,
      available,
      price: typeof s.charge === "number" ? { value: s.charge, currency } : null,
    });
  }
  return out;
}

/**
 * What `fulfilment` says came back.
 *
 * Null means Tesco did not confirm a booking -- most often because the window
 * went to somebody else between listing it and taking it. The caller turns
 * that into an error naming that possibility, rather than reporting a
 * reservation nobody holds.
 */
export function flattenBooking(raw: { slot?: RawSlot & { reservationExpiry?: unknown } }): BookedSlot | null {
  const slot = raw.slot;
  if (!slot) return null;
  const slotId = typeof slot.id === "string" ? slot.id : null;
  const start = typeof slot.start === "string" ? slot.start : null;
  const end = typeof slot.end === "string" ? slot.end : null;
  // "Available" coming back from a BOOK is Tesco saying it did not take.
  if (!slotId || !start || !end || isAvailable(slot.status)) return null;
  return {
    slotId,
    start,
    end,
    expiresAt: typeof slot.reservationExpiry === "string" ? slot.reservationExpiry : null,
  };
}
