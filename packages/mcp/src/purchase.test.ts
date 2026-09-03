import { describe, expect, it, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { StoreRegistry, SimulatedAdapter } from "@basketed/adapters";
import {
  addToBasket,
  approveApproval,
  confirmPurchase,
  listBaskets,
  loadShoppingMode,
  openDb,
  prepareCart,
  saveShoppingMode,
  ShoppingModeError,
  rejectApproval,
  saveGuardrails,
  loadGuardrails,
  cartHash,
  GuardrailValueError,
  MAX_CAP,
  MAX_CODE_ATTEMPTS,
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
  // The purchase gate is what these tests are about, and purchase mode is
  // locked in this build (S24): `saveShoppingMode` refuses it by design, so
  // the row is written directly. The gate itself does not get weaker for it.
  unlockPurchaseMode(deps.db);
});

function unlockPurchaseMode(db: PurchaseDeps["db"]): void {
  db.prepare("INSERT INTO settings (k, v) VALUES ('shopping_mode', 'purchase') ON CONFLICT(k) DO UPDATE SET v = excluded.v").run();
}

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
    for (const name of ["basket_add_to_cart", "basket_cart_prepare", "basket_purchase_confirm"]) {
      expect(NEVER_ALLOW).toContain(name);
    }
  });
});

/* ------------------------------------------------- shopping mode (S24) */

describe("basket mode is the mode in force, and purchase mode is locked", () => {
  beforeEach(() => {
    // Back to what a fresh install has: no row at all.
    deps.db.prepare("DELETE FROM settings WHERE k = 'shopping_mode'").run();
  });

  it("reads as basket mode with nothing set, and refuses to be set to purchase", () => {
    expect(loadShoppingMode(deps.db)).toBe("basket");
    let err: unknown;
    try {
      saveShoppingMode(deps.db, "purchase");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ShoppingModeError);
    expect((err as ShoppingModeError).locked).toBe(true);
    expect(loadShoppingMode(deps.db)).toBe("basket");
    expect(saveShoppingMode(deps.db, "basket")).toBe("basket");
    expect(() => saveShoppingMode(deps.db, "yolo")).toThrow(/Unknown shopping mode/);
  });

  it("a row the code has no name for reads as the default, not as an unlock", () => {
    deps.db.prepare("INSERT INTO settings (k, v) VALUES ('shopping_mode', 'checkout')").run();
    expect(loadShoppingMode(deps.db)).toBe("basket");
  });

  it("prepare refuses in basket mode before anything is built or written", async () => {
    await expect(prepare()).rejects.toThrow(/basket mode/);
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    expect(announced).toHaveLength(0);
  });

  it("confirm refuses in basket mode and does not spend the approval", async () => {
    unlockPurchaseMode(deps.db);
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });
    deps.db.prepare("DELETE FROM settings WHERE k = 'shopping_mode'").run();

    const refused = await confirmPurchase(deps, approvalId, PRINCIPAL);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/basket mode/);
    const row = deps.db.prepare("SELECT state FROM approvals WHERE id = ?").get(approvalId) as { state: string };
    expect(row.state).toBe("APPROVED");
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
  });

  it("add-to-basket works in basket mode, records the basket, and never charges", async () => {
    const result = await addToBasket(deps, {
      items: [{ id: productIds[0]!, quantity: 2 }],
      accountHandle: "acct_sim_tesco",
      principal: PRINCIPAL,
    });
    expect(result.basketId).toMatch(/^bsk_/);
    expect(result.storeId).toBe("sim:tesco");
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0]!.quantity).toBe(2);
    // A demo twin has no real basket, and the report says so rather than
    // handing back a link to nothing.
    expect(result.mode).toBe("simulated");
    expect(result.basketUrl).toBeNull();
    expect(result.report).toMatch(/SIMULATED/);
    expect(result.report).not.toMatch(/https?:\/\//);

    const listed = listBaskets(deps.db);
    expect(listed).toHaveLength(1);
    expect(listed[0]!["id"]).toBe(result.basketId);
    expect(listed[0]!["cart_url"]).toBeNull();
    expect(Object.keys(listed[0]!)).not.toContain("account_handle");
    // Nothing on the purchase side moved.
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM spend").get()).toEqual({ n: 0 });
    // The console got a summary and no approval code: there is nothing to approve.
    expect(announced.at(-1)!.join("\n")).not.toMatch(/APPROVAL CODE/);
  });

  it("add-to-basket still needs one store, and a real product id", async () => {
    await expect(
      addToBasket(deps, { items: [{ id: "bk_sim-tesco_forged", quantity: 1 }], accountHandle: "a", principal: PRINCIPAL }),
    ).rejects.toThrow();
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

/* ------------------------------------------ the gate tells the truth (S10) */

describe("a guardrail write that is not a policy is refused", () => {
  it("refuses a negative cap rather than bricking every purchase", () => {
    expect(() => saveGuardrails(deps.db, { perOrderCap: -1 })).toThrow(GuardrailValueError);
    expect(loadGuardrails(deps.db).perOrderCap).toBe(1000);
  });

  it("refuses a cap so large it is the absence of one", () => {
    expect(() => saveGuardrails(deps.db, { dailyCap: 1e308 })).toThrow(GuardrailValueError);
    expect(() => saveGuardrails(deps.db, { dailyCap: MAX_CAP + 1 })).toThrow(GuardrailValueError);
    expect(saveGuardrails(deps.db, { dailyCap: MAX_CAP })).toBeUndefined();
  });

  it("refuses a NaN instead of silently reading back the default", () => {
    // This is the one that hid: loadGuardrails() guards a NaN it FINDS, so a
    // NaN written here read back as 250 while the panel showed what was typed.
    expect(() => saveGuardrails(deps.db, { perOrderCap: Number("not a number") })).toThrow(GuardrailValueError);
    expect(loadGuardrails(deps.db).perOrderCap).toBe(1000);
  });

  it("refuses a home currency that is not an ISO code", () => {
    expect(() => saveGuardrails(deps.db, { homeCurrency: "pounds" })).toThrow(GuardrailValueError);
    expect(loadGuardrails(deps.db).homeCurrency).toBe("GBP");
  });

  it("writes nothing at all when one field of the write is bad", () => {
    expect(() => saveGuardrails(deps.db, { homeCurrency: "USD", perOrderCap: -5 })).toThrow(GuardrailValueError);
    const after = loadGuardrails(deps.db);
    expect(after.homeCurrency).toBe("GBP");
    expect(after.perOrderCap).toBe(1000);
  });
});

describe("both human channels burn the same attempt budget", () => {
  it("locks the panel channel after the same number of wrong totals as the console", async () => {
    const { approvalId } = await prepare();

    for (let i = 1; i <= MAX_CODE_ATTEMPTS; i += 1) {
      const bad = approveApproval(deps, approvalId, PRINCIPAL, { channel: "panel", typedTotal: `${i}.00` });
      expect(bad.ok).toBe(false);
      expect(bad.attemptsLeft).toBe(MAX_CODE_ATTEMPTS - i);
    }

    const dead = approveApproval(deps, approvalId, PRINCIPAL, { channel: "panel", typedTotal: "1.00" });
    expect(dead.state).toBe("REJECTED");

    // And the right total no longer helps -- the approval is gone, not merely
    // rate-limited.
    const row = deps.db.prepare("SELECT total_value FROM approvals WHERE id = ?").get(approvalId) as {
      total_value: number;
    };
    const correct = approveApproval(deps, approvalId, PRINCIPAL, {
      channel: "panel",
      typedTotal: row.total_value.toFixed(2),
    });
    expect(correct.ok).toBe(false);
    expect(correct.state).toBe("REJECTED");
  });

  it("counts a wrong total and a wrong code against one budget", async () => {
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "panel", typedTotal: "1.00" });
    const afterCode = approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: "000000" });
    expect(afterCode.attemptsLeft).toBe(MAX_CODE_ATTEMPTS - 2);
  });
});

describe("reject reports what it actually rejected", () => {
  it("refuses to call a consumed purchase cancelled", async () => {
    const { approvalId } = await prepare();
    approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });
    await confirmPurchase(deps, approvalId, PRINCIPAL);

    // The row is CONSUMED. Answering ok: true here would tell a person the
    // purchase they tried to call off is dead when the order already exists.
    const result = rejectApproval(deps, approvalId, PRINCIPAL);
    expect(result.ok).toBe(false);
    expect(result.state).toBe("CONSUMED");
  });

  it("rejects a pending approval once, and says so only that once", async () => {
    const { approvalId } = await prepare();
    expect(rejectApproval(deps, approvalId, PRINCIPAL).ok).toBe(true);
    expect(rejectApproval(deps, approvalId, PRINCIPAL).ok).toBe(false);
  });

  it("leaves an approval a second writer already moved alone", async () => {
    const { approvalId } = await prepare();
    // Stand in for the other writer: the row moves out from under the read.
    deps.db.prepare("UPDATE approvals SET state = 'EXPIRED' WHERE id = ?").run(approvalId);
    const result = approveApproval(deps, approvalId, PRINCIPAL, { channel: "console", code: codeFromBanner() });
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------- the README is part of the surface (S12) */

/**
 * A claim in the README is a security claim. "Three approval channels, all
 * converging on one function" was written next to a type with two values in it,
 * and "tokens live only in the backend vault, AES-256-GCM" was written next to a
 * package containing `export {}`. Both read as tested facts and neither was one.
 *
 * These tests do not check prose. They check that two files cannot disagree.
 */
describe("the README does not describe a build we do not have", () => {
  it("lists exactly the approval channels the type allows", async () => {
    const src = await readFile(resolve(ROOT, "packages/commerce/src/purchase.ts"), "utf8");
    const declared = [...(/export type ApprovalChannel =([^;]+);/.exec(src)?.[1] ?? "").matchAll(/"([a-z]+)"/g)]
      .map((m) => m[1]);
    expect(declared).toEqual(["console", "panel"]);

    const readme = await readFile(resolve(ROOT, "README.md"), "utf8");
    const rows = [...readme.matchAll(/^\| \*\*([A-Z]) — /gm)].map((m) => m[1]);
    expect(rows).toHaveLength(declared.length);
  });

  it("says the vault is not built for exactly as long as it is not built", async () => {
    const vault = await readFile(resolve(ROOT, "packages/vault/src/index.ts"), "utf8");
    // `export {}` is the empty-module marker. Anything exported is a real one.
    const built = /^export (?:function|class|const|interface|type) /m.test(vault);

    const readme = await readFile(resolve(ROOT, "README.md"), "utf8");
    const disclaimed = /vault[\s\S]{0,200}?not built/i.test(readme);

    expect(disclaimed).toBe(!built);
    // And the present-tense claim that started this must not come back while
    // there is nothing behind it.
    if (!built) expect(readme).not.toMatch(/Tokens live only in the backend vault/);
  });
});
