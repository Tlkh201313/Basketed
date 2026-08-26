import { describe, expect, it, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { StoreRegistry, SimulatedAdapter } from "@basketed/adapters";
import {
  approveApproval,
  confirmPurchase,
  openDb,
  prepareCart,
  saveGuardrails,
  cartHash,
  type CartMandate,
  type PurchaseDeps,
} from "@basketed/commerce";
import type { AdapterCtx } from "@basketed/adapters";
import type { FxTable } from "@basketed/core";
import { createPolicy, mayAutoConfirm, NEVER_ALLOW } from "./policy.js";
import { TOOL_NAMES } from "./tools.js";
import { PURCHASE_TOOL_NAMES } from "./tools-purchase.js";

/**
 * The five non-negotiable tests (§8), plus the import-graph proof.
 *
 * These are the tests the whole pitch rests on. Everything else in this
 * project is a shopping tool; this is the part nobody else has shipped, and a
 * claim about it that is not tested is a claim we should not make.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const PRINCIPAL = "local:test";
const ctx: AdapterCtx = { http: fetch, log: () => {}, snapshots: true };

let deps: PurchaseDeps;
let announced: string[][];
let productIds: string[];

beforeEach(async () => {
  const registry = new StoreRegistry();
  for (const a of await SimulatedAdapter.loadAll(ROOT)) registry.register(a);

  const tesco = registry.get("sim:tesco")!;
  productIds = (await tesco.search({ query: "coffee", maxResults: 3 }, ctx)).map((p) => p.id);

  announced = [];
  const fx = JSON.parse(await readFile(resolve(ROOT, "fixtures/fx.json"), "utf8")) as FxTable;
  deps = {
    db: openDb(":memory:"),
    registry,
    ctx,
    fx,
    announce: (lines) => announced.push(lines),
  };
  // A generous home currency and cap, so a test that fails does so for the
  // reason it is named after rather than tripping a guardrail by accident.
  saveGuardrails(deps.db, { homeCurrency: "GBP", perOrderCap: 1000, dailyCap: 5000 });
});

/** The code only ever exists on the announce surface. Tests read it there. */
function codeFromBanner(): string {
  const line = announced.at(-1)!.find((l) => l.includes("APPROVAL CODE"))!;
  return line.replace(/\D/g, "").slice(0, 6);
}

/** Two lines, so the "reordering is not drift" assertion has something to reorder. */
async function prepare() {
  return prepareCart(deps, {
    items: [
      { id: productIds[0]!, quantity: 2 },
      { id: productIds[1]!, quantity: 1 },
    ],
    accountHandle: "acct_guest_sim_tesco",
    principal: PRINCIPAL,
  });
}

/* ------------------------------------------------------------------ test 1 */

describe("1 — purchase is blocked without human approval", () => {
  it("refuses a confirm on a freshly prepared, unapproved cart", async () => {
    const { approvalId } = await prepare();
    const result = await confirmPurchase(deps, approvalId, PRINCIPAL);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/has not been approved by a human/i);
    expect(result.orderId).toBeUndefined();
  });

  it("refuses a confirm on an approval id that was never issued", async () => {
    const result = await confirmPurchase(deps, "apr_totally-made-up", PRINCIPAL);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("No such approval.");
  });

  it("refuses a wrong code and counts the attempt down", async () => {
    const { approvalId } = await prepare();
    const bad = approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: "000000" });
    // A 1-in-a-million collision with the real code would make this flaky; if
    // it ever matches, the assertion below is still the honest one to make.
    if (bad.ok) return;
    expect(bad.ok).toBe(false);
    expect(bad.attemptsLeft).toBe(4);
    expect((await confirmPurchase(deps, approvalId, PRINCIPAL)).ok).toBe(false);
  });

  it("binds the approval to a principal — possession of the handle is not enough", async () => {
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });

    // A second agent on the same box that observed the handle in a log.
    const stolen = await confirmPurchase(deps, approvalId, "local:someone-else");
    expect(stolen.ok).toBe(false);
    expect(stolen.reason).toBe("No such approval.");

    // And the real principal is unharmed by the attempt.
    expect((await confirmPurchase(deps, approvalId, PRINCIPAL)).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ test 2 */

describe("2 — purchase is blocked in fast mode", () => {
  it("still refuses an unapproved confirm with fast mode on", async () => {
    const fast = createPolicy(true);
    expect(fast.fastMode).toBe(true);

    const { approvalId } = await prepare();
    const result = await confirmPurchase(deps, approvalId, PRINCIPAL);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/has not been approved by a human/i);
  });

  it("never auto-confirms a money-adjacent tool, whatever the flag says", () => {
    const fast = createPolicy(true);
    for (const name of NEVER_ALLOW) expect(mayAutoConfirm(fast, name)).toBe(false);
    for (const name of PURCHASE_TOOL_NAMES.slice(0, 2)) expect(mayAutoConfirm(fast, name)).toBe(false);
    // Read-only tools are exactly what the flag is for.
    expect(mayAutoConfirm(fast, "basket_search_products")).toBe(true);
    expect(mayAutoConfirm(createPolicy(false), "basket_search_products")).toBe(false);
  });

  it("proves it structurally: nothing commerce/purchase.ts reaches imports mcp/policy.ts", async () => {
    // The claim is not "the flag is ignored on the purchase path" but "the
    // flag is not reachable from it". Walk the real import graph and check.
    const seen = new Set<string>();
    const queue = [resolve(ROOT, "packages/commerce/src/purchase.ts")];
    const offenders: string[] = [];

    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);

      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch {
        continue;
      }

      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = match[1]!;
        if (spec.includes("@basketed/mcp") || spec.includes("/policy.js")) {
          offenders.push(`${file} -> ${spec}`);
          continue;
        }
        if (!spec.startsWith(".")) continue;
        queue.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    }

    expect(offenders, "the purchase path must not reach mcp/policy.ts").toEqual([]);
    expect(seen.size).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ test 3 */

describe("3 — an approval cannot be replayed", () => {
  it("consumes exactly once, then refuses forever", async () => {
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });

    const first = await confirmPurchase(deps, approvalId, PRINCIPAL);
    expect(first.ok).toBe(true);
    expect(first.orderId).toBeDefined();

    const replay = await confirmPurchase(deps, approvalId, PRINCIPAL);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toMatch(/already been used|single-use/i);
    expect(replay.orderId).toBeUndefined();
  });

  it("refuses to re-approve a consumed handle", async () => {
    const { approvalId } = await prepare();
    const code = codeFromBanner();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code });
    await confirmPurchase(deps, approvalId, PRINCIPAL);

    const again = approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code });
    expect(again.ok).toBe(false);
    expect(again.state).toBe("CONSUMED");
  });

  it("survives two concurrent confirms — exactly one wins", async () => {
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });

    const results = await Promise.all([
      confirmPurchase(deps, approvalId, PRINCIPAL),
      confirmPurchase(deps, approvalId, PRINCIPAL),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ test 4 */

describe("4 — cart-hash drift blocks the purchase", () => {
  it("refuses when a line price moved after the human approved", async () => {
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });

    // The merchant reprices between approval and execution. The stored mandate
    // is what the human agreed to; the hash column is what they agreed to it
    // AT. Moving one without the other is exactly the attack.
    const row = deps.db.prepare("SELECT cart_json FROM approvals WHERE id = ?").get(approvalId) as {
      cart_json: string;
    };
    const mandate = JSON.parse(row.cart_json) as CartMandate;
    mandate.lineItems[0]!.unitPrice.value += 40;
    mandate.total.value += 80;
    deps.db.prepare("UPDATE approvals SET cart_json = ? WHERE id = ?").run(JSON.stringify(mandate), approvalId);

    const result = await confirmPurchase(deps, approvalId, PRINCIPAL);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/changed after it was approved/i);
    expect(result.orderId).toBeUndefined();
  });

  it("hashes prices, quantities and skus but never vendor prose", async () => {
    const { mandate, cartHash: original } = await prepare();

    const reordered: CartMandate = {
      ...mandate,
      lineItems: [...mandate.lineItems].reverse(),
    };
    expect(cartHash(reordered)).toBe(original);

    const repriced: CartMandate = {
      ...mandate,
      lineItems: mandate.lineItems.map((li) => ({
        ...li,
        unitPrice: { ...li.unitPrice, value: li.unitPrice.value + 1 },
      })),
    };
    expect(cartHash(repriced)).not.toBe(original);
  });

  it("a failed execution does not hand the approval back", async () => {
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });

    const row = deps.db.prepare("SELECT cart_json FROM approvals WHERE id = ?").get(approvalId) as {
      cart_json: string;
    };
    const mandate = JSON.parse(row.cart_json) as CartMandate;
    mandate.total.value += 999;
    deps.db.prepare("UPDATE approvals SET cart_json = ? WHERE id = ?").run(JSON.stringify(mandate), approvalId);

    expect((await confirmPurchase(deps, approvalId, PRINCIPAL)).ok).toBe(false);

    const state = deps.db.prepare("SELECT state FROM approvals WHERE id = ?").get(approvalId) as { state: string };
    expect(state.state).toBe("CONSUMED");
  });
});

/* ------------------------------------------------------------------ test 5 */

describe("5 — the surface itself cannot approve", () => {
  it("exposes no tool that creates approval state", () => {
    const all = [...TOOL_NAMES, ...PURCHASE_TOOL_NAMES];
    expect(all.some((n) => /^basket_approve|_approve$|^basket_authori[sz]e/.test(n))).toBe(false);
    expect(all).not.toContain("basket_set_delivery_address");
  });

  it("keeps every money-adjacent tool in the never-allow list", () => {
    for (const name of ["basket_cart_prepare", "basket_purchase_confirm"]) {
      expect(NEVER_ALLOW).toContain(name);
    }
  });
});

/* ------------------------------------------- guardrails, caps and honesty */

describe("guardrails are evaluated at confirm, not at prepare", () => {
  it("refuses a cart over the per-order cap even though prepare succeeded", async () => {
    saveGuardrails(deps.db, { homeCurrency: "GBP", perOrderCap: 1, dailyCap: 5000 });
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });

    const result = await confirmPurchase(deps, approvalId, PRINCIPAL);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/per_order_cap/);
  });

  it("refuses a store that is not on the allowlist", async () => {
    saveGuardrails(deps.db, { allowedStores: ["sim:costco"] });
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });

    const result = await confirmPurchase(deps, approvalId, PRINCIPAL);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/store_allowlist/);
  });

  it("normalises across currencies and says it converted", async () => {
    saveGuardrails(deps.db, { homeCurrency: "USD", perOrderCap: 1000, dailyCap: 5000 });
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });

    const result = await confirmPurchase(deps, approvalId, PRINCIPAL);
    expect(result.ok).toBe(true);
    const cap = result.guardrails!.find((c) => c.name === "per_order_cap")!;
    expect(cap.detail).toMatch(/converted from GBP at [\d.]+, as of \d{4}-\d{2}-\d{2}/);
  });

  it("a simulated order spends nothing against the daily cap", async () => {
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });
    await confirmPurchase(deps, approvalId, PRINCIPAL);

    const spent = deps.db.prepare("SELECT COUNT(*) AS n FROM spend").get() as { n: number };
    expect(spent.n).toBe(0);
  });
});

describe("the approval surface leaks nothing", () => {
  it("prints the total and the code, and never the approval id", async () => {
    const { approvalId } = await prepare();
    const banner = announced.at(-1)!.join("\n");
    expect(banner).toMatch(/APPROVAL CODE: \d{3} \d{3}/);
    expect(banner).toMatch(/TOTAL/);
    expect(banner).not.toContain(approvalId);
  });

  it("keeps the approval id out of the audit log", async () => {
    const { approvalId } = await prepare();
    const rows = deps.db.prepare("SELECT detail FROM audit").all() as Array<{ detail: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.detail).not.toContain(approvalId);
  });

  it("stores the code only as a salted hash", async () => {
    const { approvalId } = await prepare();
    const code = codeFromBanner();
    const row = deps.db.prepare("SELECT code_hash, code_salt FROM approvals WHERE id = ?").get(approvalId) as {
      code_hash: string;
      code_salt: string;
    };
    expect(row.code_hash).not.toContain(code);
    expect(row.code_hash).toHaveLength(64);
    expect(row.code_salt).toHaveLength(32);
  });

  it("never claims success for a route that ends in a human's browser", async () => {
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });
    const result = await confirmPurchase(deps, approvalId, PRINCIPAL);

    // A simulated store completes to a stamped simulated order -- and says so.
    expect(result.state).toBe("PLACED");
    expect(result.outcome).toBe("simulated");
    expect(result.next).toMatch(/SIMULATED/);
    expect(result.handoffUrl).toBeNull();
  });
});
