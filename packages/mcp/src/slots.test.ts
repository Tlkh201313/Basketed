import { describe, expect, it } from "vitest";
import { NEVER_ALLOW, createPolicy, mayAutoConfirm } from "./policy.js";
import { FETCH_TOOL_NAMES, TOOL_NAMES } from "./tools.js";
import { PURCHASE_TOOL_NAMES } from "./tools-purchase.js";
import { MAX_SLOT_SPAN_DAYS, slotWindow } from "./tools-slots.js";
import { FALLBACK_FX, loadFx } from "./fx-load.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
describe("slotWindow", () => {
  /** 2026-03-15T00:00:00Z, so the defaults below are predictable. */
  const NOW = Date.parse("2026-03-15T00:00:00Z");

  function ok(args: { start?: string; end?: string }) {
    const w = slotWindow(args, NOW);
    if (!w.ok) throw new Error(`expected a window, got: ${w.error}`);
    return w;
  }

  function err(args: { start?: string; end?: string }) {
    const w = slotWindow(args, NOW);
    if (w.ok) throw new Error(`expected a refusal, got ${w.start}..${w.end}`);
    return w.error;
  }

  it("defaults to today through a week out", () => {
    expect(ok({})).toMatchObject({ start: "2026-03-15", end: "2026-03-22" });
  });

  it("defaults the end relative to the start it was given, not to today", () => {
    expect(ok({ start: "2026-04-01" }).end).toBe("2026-04-08");
  });

  it("refuses a day that is not on the calendar", () => {
    // The zod regex proves the shape and nothing else. February has never had
    // a 30th, and this used to travel onwards as the string "Invalid Date".
    expect(err({ start: "2026-02-30" })).toMatch(/not a date on the calendar/i);
    expect(err({ start: "2026-13-01" })).toMatch(/not a date on the calendar/i);
    expect(err({ start: "2026-03-15", end: "2026-06-31" })).toMatch(/not a date on the calendar/i);
  });

  it("takes a real leap day", () => {
    expect(ok({ start: "2028-02-29", end: "2028-03-01" }).start).toBe("2028-02-29");
  });

  it("refuses a range that ends before it starts", () => {
    expect(err({ start: "2026-03-20", end: "2026-03-18" })).toMatch(/ends before it starts/i);
  });

  it("allows a single day", () => {
    expect(ok({ start: "2026-03-20", end: "2026-03-20" }).end).toBe("2026-03-20");
  });

  it(`allows exactly ${MAX_SLOT_SPAN_DAYS} days and refuses one more`, () => {
    const day = 86_400_000;
    const at = (n: number) => new Date(NOW + n * day).toISOString().slice(0, 10);
    expect(ok({ start: at(0), end: at(MAX_SLOT_SPAN_DAYS - 1) }).ok).toBe(true);
    expect(err({ start: at(0), end: at(MAX_SLOT_SPAN_DAYS) })).toMatch(/at most 30/i);
  });

  it("never throws, whatever it is handed", () => {
    // isoDate(NaN) used to raise a RangeError out of the tool handler with
    // nothing in the message about the date that caused it.
    for (const start of ["", "tomorrow", "15-03-2026", "2026-3-5", "0000-00-00"]) {
      expect(() => slotWindow({ start }, NOW)).not.toThrow();
      expect(slotWindow({ start }, NOW).ok).toBe(false);
    }
  });
});

describe("loadFx", () => {
  async function root(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "basketed-fx-"));
    await mkdir(resolve(dir, "fixtures"), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(resolve(dir, "fixtures", name), body, "utf8");
    }
    return dir;
  }

  it("reads the pinned table", async () => {
    const said: string[] = [];
    const fx = await loadFx(process.cwd(), (m) => said.push(m));
    expect(fx.rates["GBP"]).toBeGreaterThan(0);
    expect(said).toEqual([]);
  });

  it("falls back and says so when the file is missing", async () => {
    // Search, cart and orders have nothing to do with this file. Throwing out
    // of createRuntime cost a shopper all three because of a currency table.
    const said: string[] = [];
    const fx = await loadFx(await root({}), (m) => said.push(m));
    expect(fx).toEqual(FALLBACK_FX);
    expect(said.join(" ")).toMatch(/no FX table/i);
  });

  it("falls back on a truncated file rather than throwing", async () => {
    const said: string[] = [];
    const fx = await loadFx(await root({ "fx.json": '{"base":"USD","rates":{' }), (m) => said.push(m));
    expect(fx).toEqual(FALLBACK_FX);
    expect(said.join(" ")).toMatch(/not valid JSON/i);
  });

  it("falls back on JSON that parses but is not a rate table", async () => {
    for (const body of ["[]", "null", '{"base":"USD"}', '{"base":"USD","rates":{}}', '{"base":"GBP","rates":{"USD":1}}', '{"base":"USD","rates":{"USD":"1"}}', '{"base":"USD","rates":{"USD":0}}']) {
      const said: string[] = [];
      expect(await loadFx(await root({ "fx.json": body }), (m) => said.push(m))).toEqual(FALLBACK_FX);
      expect(said).toHaveLength(1);
    }
  });

  it("refuses unknown currencies rather than guessing parity", () => {
    // The fallback is the smallest HONEST table, not a guess at the missing
    // rates: a cap quoted in a currency we cannot price must be refused, and
    // treating it as 1:1 is how a guardrail stops meaning anything.
    expect(Object.keys(FALLBACK_FX.rates)).toEqual(["USD"]);
  });
});
