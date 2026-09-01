import { describe, expect, it, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StoreRegistry, SimulatedAdapter } from "@basketed/adapters";
import type { AdapterCtx, StoreAdapter, RawCart } from "@basketed/adapters";
import type { FxTable } from "@basketed/core";
import { openDb } from "./db.js";
import { saveGuardrails } from "./guardrails.js";
import { approveApproval, confirmPurchase, prepareCart, type PurchaseDeps } from "./purchase.js";

/**
 * What confirm does before it spends a human's approval.
 *
 * The old order consumed first and checked afterwards, so every later refusal
 * cost the click: a guardrail the human could go and change, or a merchant
 * being briefly unreachable, both left the approval CONSUMED with no order
 * behind it. These tests pin which refusals leave it usable and which do not.
 *
 * The simulated Tesco is wrapped in a Proxy so `buildCart` can be made to
 * drift, hang or fail without a network or a fixture for each case.
 */

/** What buildCart takes: the shape the adapter contract declares inline. */
type CartItem = { id: string; quantity: number };

const ROOT = resolve(import.meta.dirname, "../../..");
const PRINCIPAL = "local:test";
const ctx: AdapterCtx = { http: fetch, log: () => {}, snapshots: true };

let deps: PurchaseDeps;
let announced: string[][];
let productIds: string[];
let base: StoreAdapter;
/** Replaces the store's buildCart for one test. Null means "behave normally". */
let cartOverride: ((items: CartItem[], c: AdapterCtx) => Promise<RawCart>) | null;

beforeEach(async () => {
  const registry = new StoreRegistry();
  for (const a of await SimulatedAdapter.loadAll(ROOT)) registry.register(a);

  base = registry.get("sim:tesco")!;
  productIds = (await base.search({ query: "coffee", maxResults: 3 }, ctx)).map((p) => p.id);
  cartOverride = null;

  // The same adapter with a swappable cart, so the ids minted above stay
  // valid -- they are signed for this store and would not verify for another.
  const wrapped = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "buildCart") {
        return (items: CartItem[], c: AdapterCtx) =>
          cartOverride ? cartOverride(items, c) : target.buildCart!(items, c);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as StoreAdapter;

  const proxiedRegistry = {
    get: (id: string) => (id === "sim:tesco" ? wrapped : registry.get(id)),
    all: () => registry.all(),
    list: () => registry.list(),
  } as unknown as StoreRegistry;

  announced = [];
  const fx = JSON.parse(await readFile(resolve(ROOT, "fixtures/fx.json"), "utf8")) as FxTable;
  deps = {
    db: openDb(":memory:"),
    registry: proxiedRegistry,
    ctx,
    fx,
    announce: (lines) => announced.push(lines),
  };
  saveGuardrails(deps.db, { homeCurrency: "GBP", perOrderCap: 1000, dailyCap: 5000 });
});

function codeFromBanner(): string {
  // Printed as "408 055" -- grouped so a human can read it aloud.
  const line = announced.at(-1)!.find((l) => l.includes("APPROVAL CODE"))!;
  return line.replace(/[^0-9]/g, "").slice(0, 6);
}

async function approved(): Promise<string> {
  const prep = await prepareCart(deps, {
    principal: PRINCIPAL,
    accountHandle: "acct_test",
    items: [{ id: productIds[0]!, quantity: 1 }],
  });
  approveApproval(deps, prep.approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });
  return prep.approvalId;
}

function stateOf(id: string): string {
  return (deps.db.prepare("SELECT state FROM approvals WHERE id = ?").get(id) as { state: string }).state;
}

function orderCount(): number {
  return (deps.db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
}

describe("prepareCart", () => {
  it("gives up on a merchant that never answers, rather than hanging forever", async () => {
    // buildCart is the one call in the purchase path that reaches a retailer,
    // and an adapter is not obliged to have a timeout of its own.
    cartOverride = () => new Promise<RawCart>(() => {});
    deps.buildCartTimeoutMs = 40;
    await expect(
      prepareCart(deps, {
        principal: PRINCIPAL,
        accountHandle: "acct_test",
        items: [{ id: productIds[0]!, quantity: 1 }],
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("refuses a product id that was never minted here", async () => {
    await expect(
      prepareCart(deps, {
        principal: PRINCIPAL,
        accountHandle: "acct_test",
        items: [{ id: "bk_sim-tesco_forged-item_AAAAAAAA", quantity: 1 }],
      }),
    ).rejects.toThrow(/No such product/i);
  });
});

describe("confirmPurchase — what it checks, and in what order", () => {
  it("buys the cart when nothing has changed", async () => {
    const id = await approved();
    const result = await confirmPurchase(deps, id, PRINCIPAL);
    expect(result.ok).toBe(true);
    expect(stateOf(id)).toBe("CONSUMED");
    expect(orderCount()).toBe(1);
  });

  it("voids the approval when the merchant has repriced the cart", async () => {
    const id = await approved();
    cartOverride = async (items, c) => {
      const real = await base.buildCart!(items, c);
      return { ...real, total: { ...real.total, value: real.total.value + 5 } };
    };

    const result = await confirmPurchase(deps, id, PRINCIPAL);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/total has risen/i);
    // Voided, not spent: the human approved a cart that no longer exists, and
    // leaving it confirmable is how the new price gets bought.
    expect(stateOf(id)).toBe("REJECTED");
    expect(orderCount()).toBe(0);
  });

  it("says which line moved, not just that something did", async () => {
    const id = await approved();
    cartOverride = async (items, c) => {
      const real = await base.buildCart!(items, c);
      const [first, ...rest] = real.lineItems;
      return { ...real, lineItems: [{ ...first!, quantity: first!.quantity + 1 }, ...rest] };
    };
    const result = await confirmPurchase(deps, id, PRINCIPAL);
    expect(result.reason).toMatch(/quantity of .* changed from 1 to 2/i);
  });

  it("keeps the approval alive when the merchant cannot be reached", async () => {
    const id = await approved();
    cartOverride = async () => {
      throw new Error("Tesco cart returned HTTP 503.");
    };

    const first = await confirmPurchase(deps, id, PRINCIPAL);
    expect(first.ok).toBe(false);
    expect(first.reason).toMatch(/still good/i);
    // A retailer being down is not evidence that anything drifted, and
    // burning a human's click on an outage punishes them for it.
    expect(stateOf(id)).toBe("APPROVED");

    cartOverride = null;
    expect((await confirmPurchase(deps, id, PRINCIPAL)).ok).toBe(true);
  });

  it("keeps the approval alive when a guardrail refuses", async () => {
    const id = await approved();
    // A cap is a rule the human owns. Making them re-approve after raising
    // their own limit is a punishment for using the feature.
    saveGuardrails(deps.db, { homeCurrency: "GBP", perOrderCap: 0.01, dailyCap: 5000 });

    const refused = await confirmPurchase(deps, id, PRINCIPAL);
    expect(refused.ok).toBe(false);
    expect(refused.guardrails?.length).toBeGreaterThan(0);
    expect(stateOf(id)).toBe("APPROVED");
    expect(orderCount()).toBe(0);

    saveGuardrails(deps.db, { homeCurrency: "GBP", perOrderCap: 1000, dailyCap: 5000 });
    expect((await confirmPurchase(deps, id, PRINCIPAL)).ok).toBe(true);
  });

  it("refuses an approval that was never approved", async () => {
    const prep = await prepareCart(deps, {
      principal: PRINCIPAL,
      accountHandle: "acct_test",
      items: [{ id: productIds[0]!, quantity: 1 }],
    });
    const result = await confirmPurchase(deps, prep.approvalId, PRINCIPAL);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not been approved/i);
    expect(orderCount()).toBe(0);
  });

  it("refuses a caller who is not the principal the approval was bound to", async () => {
    const id = await approved();
    const result = await confirmPurchase(deps, id, "local:someone-else");
    expect(result.ok).toBe(false);
    // Possession of a handle is never authentication.
    expect(result.reason).toMatch(/No such approval/i);
    expect(stateOf(id)).toBe("APPROVED");
  });

  it("refuses an expired approval", async () => {
    const id = await approved();
    deps.db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, id);
    const result = await confirmPurchase(deps, id, PRINCIPAL);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired/i);
    expect(orderCount()).toBe(0);
  });

  it("lets exactly one of two concurrent confirms through", async () => {
    const id = await approved();
    // The consume is one atomic statement precisely so this cannot buy twice.
    const [a, b] = await Promise.all([
      confirmPurchase(deps, id, PRINCIPAL),
      confirmPurchase(deps, id, PRINCIPAL),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(orderCount()).toBe(1);
  });

  it("cannot be used a second time after a successful purchase", async () => {
    const id = await approved();
    expect((await confirmPurchase(deps, id, PRINCIPAL)).ok).toBe(true);
    const replay = await confirmPurchase(deps, id, PRINCIPAL);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toMatch(/already been used|single-use/i);
    expect(orderCount()).toBe(1);
  });
});

describe("approving twice", () => {
  it("accepts a code for a cart the human already approved in the panel", async () => {
    // The two channels race by design: a person reads the code off the
    // console and hands it over, and may click Approve in the panel while
    // doing it. Refusing the code then told the agent the purchase had
    // failed when it was in fact ready to go.
    const id = await approved();
    const again = approveApproval(deps, id, PRINCIPAL, { channel: "console", code: codeFromBanner() });
    expect(again.ok).toBe(true);
    expect(again.state).toBe("APPROVED");
    expect((await confirmPurchase(deps, id, PRINCIPAL)).ok).toBe(true);
  });

  it("charges no attempt for it", async () => {
    const id = await approved();
    approveApproval(deps, id, PRINCIPAL, { channel: "console", code: "000000" });
    const row = deps.db.prepare("SELECT attempts FROM approvals WHERE id = ?").get(id) as { attempts: number };
    expect(row.attempts).toBe(0);
  });

  it("still refuses one that was rejected", async () => {
    const id = await approved();
    deps.db.prepare("UPDATE approvals SET state = 'REJECTED' WHERE id = ?").run(id);
    const result = approveApproval(deps, id, PRINCIPAL, { channel: "console", code: codeFromBanner() });
    expect(result.ok).toBe(false);
    expect(result.state).toBe("REJECTED");
  });
});
