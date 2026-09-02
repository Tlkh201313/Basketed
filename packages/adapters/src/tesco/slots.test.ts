import { describe, expect, it } from "vitest";
import { flattenSlots, flattenBooking } from "./slots.js";

/**
 * The shape `delivery` actually returns, trimmed to the fields we read.
 *
 * Taken from the `Slot` fragment in GavinAttard/tesco-grocery-mcp (MIT), which
 * is that project's capture of what tesco.com's own slots page asks for --
 * NOT from the plan's guess at it. `charge` is a bare number, and the id field
 * is `id`, not `slotId`.
 */
const RAW = [
  { id: "s1", start: "2026-09-03T09:00:00+01:00", end: "2026-09-03T10:00:00+01:00", status: "Available", charge: 4.5 },
  { id: "s2", start: "2026-09-03T10:00:00+01:00", end: "2026-09-03T11:00:00+01:00", status: "Unavailable", charge: 0 },
];

describe("flattenSlots", () => {
  it("keeps only bookable slots by default, and prices them in the store's currency", () => {
    const out = flattenSlots(RAW, "GBP", false);
    expect(out).toEqual([
      {
        id: "s1",
        start: "2026-09-03T09:00:00+01:00",
        end: "2026-09-03T10:00:00+01:00",
        available: true,
        price: { value: 4.5, currency: "GBP" },
      },
    ]);
  });

  it("includes the unbookable ones when asked, marked as such", () => {
    const out = flattenSlots(RAW, "GBP", true);
    expect(out).toHaveLength(2);
    expect(out[1]?.available).toBe(false);
  });

  it("reads a free slot as free, not as unpriced", () => {
    const [free] = flattenSlots([{ ...RAW[0], charge: 0 }], "GBP", false);
    expect(free?.price).toEqual({ value: 0, currency: "GBP" });
  });

  it("leaves price null when Tesco sends no charge at all", () => {
    const [none] = flattenSlots([{ id: "s3", start: "a", end: "b", status: "Available" }], "GBP", false);
    expect(none?.price).toBeNull();
  });

  it("drops a slot with no id rather than inventing one", () => {
    expect(flattenSlots([{ start: "a", end: "b", status: "Available" }], "GBP", true)).toEqual([]);
  });

  it("is case-insensitive about the status Tesco sends", () => {
    expect(flattenSlots([{ id: "s4", start: "a", end: "b", status: "AVAILABLE" }], "GBP", false)).toHaveLength(1);
  });
});

describe("flattenBooking", () => {
  it("reads back the window that was actually reserved, and when it lapses", () => {
    const booked = flattenBooking({
      slot: {
        id: "s1",
        status: "Booked",
        start: "2026-09-03T09:00:00+01:00",
        end: "2026-09-03T10:00:00+01:00",
        reservationExpiry: "2026-09-03T07:00:00+01:00",
      },
    });
    expect(booked).toEqual({
      slotId: "s1",
      start: "2026-09-03T09:00:00+01:00",
      end: "2026-09-03T10:00:00+01:00",
      expiresAt: "2026-09-03T07:00:00+01:00",
    });
  });

  it("says nothing about an expiry Tesco did not give", () => {
    const booked = flattenBooking({ slot: { id: "s1", start: "a", end: "b", status: "Booked" } });
    expect(booked?.expiresAt).toBeNull();
  });

  it("returns null when Tesco confirmed no slot -- someone else took it", () => {
    expect(flattenBooking({})).toBeNull();
    expect(flattenBooking({ slot: { status: "Available" } })).toBeNull();
  });
});
