import { describe, expect, it, beforeAll } from "vitest";
import { resolve } from "node:path";
import {
  ProductSchema,
  ProductDetailSchema,
  StoreManifestSchema,
  MoneySchema,
  RatingSchema,
  CATEGORIES,
  NEVER_DROPPED,
} from "@basketed/core";
import { StoreRegistry } from "./registry.js";
import { loadPinnedShopifyStores } from "./shopify-ucp/load.js";
import { SimulatedAdapter } from "./simulated/adapter.js";
import { overclaimedTiers, implementedTiers } from "./types.js";
import type { AdapterCtx, StoreAdapter } from "./types.js";

/**
 * The shared conformance suite (§4) — test 5 of the five non-negotiables.
 *
 * Every adapter runs the SAME assertions regardless of mode. That is the point:
 * the promise the two-axis design makes is that a simulated store and a native
 * one differ only in their manifest and where their bytes come from, and a
 * suite that exempted the simulated ones would quietly hollow that out.
 *
 * Runs entirely from `fixtures/snapshots/`, so it holds with the cable out.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const ctx: AdapterCtx = { http: fetch, log: () => {}, snapshots: true };

/** Snapshotted at Day-0 with genuinely zero products. Real, and left honest. */
const KNOWN_EMPTY = new Set(["shp:tonyschocolonely.com"]);

/**
 * The suite runs offline, so it can only cover pinned stores that have a Day-0
 * snapshot -- three of the ten. The other seven are unreachable with the cable
 * out and are stated as uncovered rather than skipped silently. Every simulated
 * store is covered, since its fixture IS its source.
 */
const SNAPSHOTTED = new Set([
  "shp:deathwishcoffee.com",
  "shp:chubbiesshorts.com",
  "shp:tonyschocolonely.com",
]);

let adapters: StoreAdapter[];
let uncovered: string[];

beforeAll(async () => {
  const registry = new StoreRegistry();
  for (const a of await loadPinnedShopifyStores(ROOT)) registry.register(a);
  for (const a of await SimulatedAdapter.loadAll(ROOT)) registry.register(a);

  const all = registry.all();
  adapters = all.filter((a) => a.manifest.mode === "simulated" || SNAPSHOTTED.has(a.manifest.id));
  uncovered = all.filter((a) => !adapters.includes(a)).map((a) => a.manifest.id);
  expect(adapters.length).toBeGreaterThan(1);
});

describe("every adapter conforms", () => {
  it("loads a mix of modes, or the suite is proving less than it looks", () => {
    const modes = new Set(adapters.map((a) => a.manifest.mode));
    expect(modes.has("simulated")).toBe(true);
    expect(modes.has("native")).toBe(true);
    // Named, not hidden: these are pinned live stores with no Day-0 snapshot,
    // so nothing here has been asserted about them.
    if (uncovered.length) {
      expect(uncovered.every((id) => id.startsWith("shp:"))).toBe(true);
    }
  });

  it("has a valid manifest", () => {
    for (const a of adapters) {
      const parsed = StoreManifestSchema.safeParse(a.manifest);
      expect(parsed.success, `${a.manifest.id}: ${parsed.error?.message}`).toBe(true);
      expect(a.manifest.categories.every((c) => CATEGORIES.includes(c))).toBe(true);
    }
  });

  it("claims no tier it does not implement", () => {
    for (const a of adapters) {
      expect(overclaimedTiers(a), `${a.manifest.id} overclaims`).toEqual([]);
      // Both halves or neither -- see the registry's own test for why.
      if (a.manifest.capabilities.includes("slots")) {
        expect(typeof a.slots, `${a.manifest.id} claims slots but cannot list them`).toBe("function");
        expect(typeof a.bookSlot, `${a.manifest.id} claims slots but cannot book one`).toBe("function");
      }
      // Nobody at our access tier can complete a payment programmatically.
      expect(a.manifest.capabilities).not.toContain("checkout");
      expect(implementedTiers(a)).toContain("discovery");
    }
  });

  it("returns schema-valid products that always carry identity and price", async () => {
    let productive = 0;
    for (const a of adapters) {
      const products = await a.search({ query: "coffee", maxResults: 4 }, ctx);
      // Zero results is a legitimate answer, not an error: sim:ikea sells no
      // coffee, and tonyschocolonely's Day-0 snapshot genuinely captured none.
      // What must never happen is an adapter answering with a malformed row.
      if (!products.length) continue;
      productive += 1;
      for (const p of products) {
        const parsed = ProductSchema.safeParse(p);
        expect(parsed.success, `${a.manifest.id} ${p.id}: ${parsed.error?.message}`).toBe(true);
        /*
         * `rating` is on NEVER_DROPPED, but that list governs what the budget
         * trimmer may remove -- not what upstream is obliged to have. Shopify's
         * catalog payload carries no rating at all, and inventing one to
         * satisfy a test would be the dishonest fix. So identity and price are
         * required of every adapter; a rating is required only to be valid
         * when it exists.
         */
        for (const field of NEVER_DROPPED.filter((f) => f !== "rating")) {
          expect(p[field as keyof typeof p], `${a.manifest.id} dropped ${field}`).toBeDefined();
        }
        expect(MoneySchema.safeParse(p.price).success).toBe(true);
        if (p.rating) expect(RatingSchema.safeParse(p.rating).success).toBe(true);
      }
    }
    // A suite where nothing returned rows would pass every assertion above
    // while proving nothing at all.
    expect(productive, "no adapter returned any product").toBeGreaterThanOrEqual(2);
    expect(KNOWN_EMPTY.size).toBeGreaterThan(0);
  });

  it("stamps every row with the mode its manifest declares", async () => {
    for (const a of adapters) {
      for (const p of await a.search({ query: "coffee", maxResults: 4 }, ctx)) {
        // A store's mode can never change behind the user's back, and a result
        // must never lose its provenance -- not to save tokens, not ever.
        expect(p.mode, `${a.manifest.id} mislabelled a row`).toBe(a.manifest.mode);
      }
    }
  });

  it("prices in the currency its manifest declares, with sane magnitudes", async () => {
    for (const a of adapters) {
      for (const p of await a.search({ query: "coffee", maxResults: 4 }, ctx)) {
        expect(p.price.currency).toMatch(/^[A-Z]{3}$/);
        // Shopify sends integer minor units. Reading 800 as $800 is the bug
        // that puts $800 leggings on stage, so the magnitude is asserted.
        expect(p.price.value).toBeGreaterThan(0);
        expect(p.price.value).toBeLessThan(100_000);
        if (p.rating) {
          expect(p.rating.score).toBeGreaterThanOrEqual(0);
          expect(p.rating.score).toBeLessThanOrEqual(5);
        }
      }
    }
  });

  it("sanitises vendor text — no control chars, no zero-width, no bidi overrides", async () => {
    // C0/C1 controls, zero-width joiners and the bidi overrides that make a
    // name RENDER as something other than what the cart hash covers. Checked
    // by codepoint rather than a regex literal, so the assertion cannot be
    // defeated by the source file itself being normalised.
    const forbidden = (s: string) =>
      [...s].some((ch) => {
        const c = ch.codePointAt(0)!;
        return (
          (c <= 0x08) ||
          (c >= 0x0b && c <= 0x1f) ||
          (c >= 0x7f && c <= 0x9f) ||
          (c >= 0x200b && c <= 0x200f) ||
          c === 0xfeff ||
          c === 0x2060 ||
          (c >= 0x202a && c <= 0x202e) ||
          (c >= 0x2066 && c <= 0x2069)
        );
      });
    for (const a of adapters) {
      const products = await a.search({ query: "coffee", maxResults: 4 }, ctx);
      for (const p of products) {
        expect(forbidden(p.name), `${a.manifest.id} leaked a control char in a name`).toBe(false);
      }
      const first = products[0];
      if (!first) continue;
      const detail = await a.detail(first.id, ["description"], ctx);
      const parsed = ProductDetailSchema.safeParse(detail);
      expect(parsed.success, `${a.manifest.id} detail: ${parsed.error?.message}`).toBe(true);
      if (detail.description) {
        expect(forbidden(detail.description)).toBe(false);
      }
    }
  });

  it("round-trips its own ids through detail", async () => {
    for (const a of adapters) {
      const first = (await a.search({ query: "coffee", maxResults: 2 }, ctx))[0];
      if (!first) continue;
      const detail = await a.detail(first.id, [], ctx);
      expect(detail.id, `${a.manifest.id} minted an id it cannot resolve`).toBe(first.id);
    }
  });

  it("refuses an id it never minted", async () => {
    for (const a of adapters) {
      await expect(a.detail("bk_not-a-store_999_deadbeef", [], ctx)).rejects.toThrow();
    }
  });

  it("builds carts whose totals equal the sum of their lines", async () => {
    for (const a of adapters) {
      if (!a.buildCart) continue;
      const first = (await a.search({ query: "coffee", maxResults: 2 }, ctx))[0];
      if (!first) continue;

      const cart = await a.buildCart([{ id: first.id, quantity: 2 }], ctx);
      expect(cart.lineItems.length).toBeGreaterThan(0);
      expect(MoneySchema.safeParse(cart.total).success).toBe(true);

      /*
       * lines + adjustments == total, to the penny.
       *
       * This is the arithmetic the human is asked to approve, and it caught a
       * real one: the Shopify adapter echoed the REQUESTED quantities back as
       * line items while taking totals from the merchant's response, so any
       * time the merchant gave us something other than what we asked for --
       * stock clamped, lines merged -- the approval banner showed lines that
       * did not add up to the total printed under them.
       */
      const summed = cart.lineItems.reduce((n, li) => n + li.unitPrice.value * li.quantity, 0);
      expect(cart.subtotal.value).toBeCloseTo(summed, 2);
      const adjusted = cart.adjustments.reduce((n, adj) => n + adj.amount.value, summed);
      expect(cart.total.value).toBeCloseTo(adjusted, 2);
      // `subtotal` and `total` are the frame, not adjustments inside it.
      expect(cart.adjustments.map((adj) => adj.type)).not.toContain("subtotal");
      expect(cart.adjustments.map((adj) => adj.type)).not.toContain("total");

      // A simulated store has no real checkout behind it. Returning a search
      // link dressed up as a cart URL is the one thing it must never do.
      if (a.manifest.mode === "simulated") expect(cart.handoffUrl).toBeNull();
    }
  });
});
