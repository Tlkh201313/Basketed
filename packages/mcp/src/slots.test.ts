import { describe, expect, it } from "vitest";
import { NEVER_ALLOW, createPolicy, mayAutoConfirm } from "./policy.js";
import { TOOL_NAMES } from "./tools.js";

/**
 * Delivery slots on the wire.
 *
 * Listing windows is a read: it shows the shopper what is on offer and takes
 * nothing. Booking one is not. It spends no money, but it holds a window a
 * real van drives to, and the window is scarce -- taking it takes it from
 * somebody. That is a commitment, and this project's whole claim is that a
 * commitment needs a human.
 */
describe("delivery slot tools", () => {
  it("lists slots as an ordinary read-only tool", () => {
    expect(TOOL_NAMES).toContain("basket_list_delivery_slots");
  });

  it("can never auto-approve a booking, in any mode", () => {
    // If this ever passes, fast-mode can book a van with no human in the loop,
    // which is the exact thing this project exists to make impossible.
    expect(NEVER_ALLOW).toContain("basket_book_delivery_slot");
    expect(mayAutoConfirm(createPolicy(true), "basket_book_delivery_slot")).toBe(false);
  });

  it("exposes no tool that books without going through the approval rail", () => {
    // Listing is on the wire; booking is NOT a registered tool yet, and the
    // absence is the honest state -- see the note in tools-slots.ts.
    expect(TOOL_NAMES).not.toContain("basket_book_delivery_slot");
  });
});
