import { describe, expect, it } from "vitest";
import { NEVER_ALLOW, createPolicy, mayAutoConfirm } from "./policy.js";
import { FETCH_TOOL_NAMES, TOOL_NAMES } from "./tools.js";
import { PURCHASE_TOOL_NAMES } from "./tools-purchase.js";

/**
 * Delivery slots on the wire — purchase lane (need a vault session).
 */
describe("delivery slot tools", () => {
  it("lists slots on the purchase lane, not the fetch lane", () => {
    expect(PURCHASE_TOOL_NAMES).toContain("basket_list_delivery_slots");
    expect(FETCH_TOOL_NAMES).not.toContain("basket_list_delivery_slots");
    expect(TOOL_NAMES).not.toContain("basket_list_delivery_slots");
    expect(FETCH_TOOL_NAMES).toContain("basket_auth_status");
  });

  it("can never auto-approve a booking, in any mode", () => {
    // If this ever passes, fast-mode can book a van with no human in the loop,
    // which is the exact thing this project exists to make impossible.
    expect(NEVER_ALLOW).toContain("basket_book_delivery_slot");
    expect(mayAutoConfirm(createPolicy(true), "basket_book_delivery_slot")).toBe(false);
  });

  it("exposes no tool that books without going through the approval rail", () => {
    expect(PURCHASE_TOOL_NAMES).not.toContain("basket_book_delivery_slot");
    expect(FETCH_TOOL_NAMES).not.toContain("basket_book_delivery_slot");
  });
});

describe("account handles", () => {
  it("exposes basket_list_accounts on the purchase lane", () => {
    expect(PURCHASE_TOOL_NAMES).toContain("basket_list_accounts");
    expect(FETCH_TOOL_NAMES).not.toContain("basket_list_accounts");
  });
});