import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FxTable, Money } from "@basketed/core";

function isTransientCartError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /429|503|5\d\d|timeout|ECONN|ENET|ETIMEDOUT|fetch failed|blocked|captcha|rate.?limit/i.test(msg) && !/cannot build a cart/i.test(msg);
}
async function withRetryCart<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransientCartError(e) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i) + Math.random() * 200));
    }
  }
  throw last;
}
import type { AdapterCtx, StoreRegistry } from "@basketed/adapters";
import { describeRoute, productDeepLink, type PurchaseRoute } from "@basketed/adapters";
import { authorizedFetch, type Vault } from "@basketed/vault";
import type { Db } from "./db.js";
import { cartHash, describeMandate, type CartMandate, type MandateLine } from "./mandate.js";
import {
  evaluateGuardrails,
  loadGuardrails,
  recordSpend,
  type GuardrailVerdict,
  type Guardrails,
} from "./guardrails.js";

/**
 * The purchase gate (§6).
 *
 * NOTHING in this file may import from `@basketed/mcp`. `--fast-mode` lives in
 * `mcp/policy.ts`, and the guarantee we make is not "the flag is ignored on
 * the purchase path" but "the flag is not reachable from it". An import-graph
 * test asserts exactly that, so a future refactor that wires them together
 * fails CI rather than quietly re-opening the hole.
 */

export const APPROVAL_TTL_MS = 5 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

/**
 * Stores whose cart/trolley requires a sealed browser session (Connect).
 * Additive table — same idea as control's CHROME_LOGIN map.
 */
const SESSION_CART_STORES = new Set(["tsc:tesco"]);

function storeNeedsSession(storeId: string): boolean {
  return SESSION_CART_STORES.has(storeId);
}

export type ApprovalState = "PENDING" | "APPROVED" | "CONSUMED" | "REJECTED" | "EXPIRED";
export type OrderState =
  | "HANDED_OFF"
  | "PLACED"
  | "CONFIRMED"
  | "IN_DELIVERY"
  | "DELIVERED"
  | "FAILED"
  | "CANCELLED";

export interface PurchaseDeps {
  db: Db;
  registry: StoreRegistry;
  ctx: AdapterCtx;
  fx: FxTable;
  /**
   * Credential store, so `buildCart` can hand a store's own adapter a
   * request-preauthorised fetch for exactly its own id -- never a raw secret;
   * see `authorizedFetch`. Optional because most existing PurchaseDeps
   * construction sites (tests, the offline drill) have no vault and no
   * authenticated store, and search/detail never need one at all.
   */
  vault?: Vault;
  /**
   * Where the approval code is announced.
   *
   * This MUST be a surface the model cannot read -- the server's own console,
   * or the panel. Channel C is safe precisely because the agent has no read
   * access to it: the only way it obtains the code is for a human to read it
   * and hand it over, which is the human act we are trying to require.
   */
  announce: (lines: string[]) => void;
  /**
   * Where the panel is served, WITHOUT the token -- e.g. http://127.0.0.1:8787.
   *
   * This one ends up in `approve_url`, which is a tool result the model reads,
   * so it must stay token-free. It is only useful to a human who already has
   * the token; to anything else it is a link to a locked page.
   */
  panelBase?: string;
  /**
   * Called when a cart is sitting there waiting on a person.
   *
   * Deliberately a separate hook from `announce`: this one is allowed to know
   * the panel token, because the CLI wires it to the server's own console and
   * to the local browser -- never to anything the model can read. Keeping the
   * token out of this file is the point of the split.
   */
  summon?: (approvalId: string) => void;
  now?: () => number;
}

interface ApprovalRow {
  id: string;
  principal: string;
  state: ApprovalState;
  store_id: string;
  account_handle: string;
  cart_id: string | null;
  cart_hash: string;
  cart_json: string;
  total_value: number;
  total_currency: string;
  code_hash: string;
  code_salt: string;
  attempts: number;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  approved_channel: string | null;
  approved_total: string | null;
  consumed_at: number | null;
}

/* --------------------------------------------------------------- helpers */

/** CSPRNG, base64url, never sequential and never derived from cart contents. */
function mintApprovalId(): string {
  return `apr_${randomBytes(32).toString("base64url")}`;
}

/** Six digits, uniformly drawn. Announced once, stored only as a salted hash. */
function mintCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function codeMatches(supplied: string, row: Pick<ApprovalRow, "code_hash" | "code_salt">): boolean {
  const a = Buffer.from(hashCode(supplied.replace(/\D/g, ""), row.code_salt), "hex");
  const b = Buffer.from(row.code_hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Approval ids never reach a log, an audit row or an error message -- they go
 * through the same redaction path as secrets. This fingerprint is enough to
 * correlate two events and useless to replay.
 */
export function fingerprint(approvalId: string): string {
  return createHash("sha256").update(approvalId).digest("hex").slice(0, 12);
}

function audit(db: Db, kind: string, detail: string, at: number): void {
  db.prepare("INSERT INTO audit (at, kind, detail) VALUES (?, ?, ?)").run(at, kind, detail);
}

function readApproval(db: Db, id: string): ApprovalRow | undefined {
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
}

/* --------------------------------------------------------- cart_prepare */

export interface PrepareInput {
  items: Array<{ id: string; quantity: number }>;
  accountHandle: string;
  /** Derived from the verified local session by the caller. Never from the agent. */
  principal: string;
  addressId?: string;
}

export interface PrepareResult {
  approvalId: string;
  approveUrl: string;
  expiresAt: string;
  mandate: CartMandate;
  cartHash: string;
  summary: string[];
  /** How the human is expected to approve, given what this client supports. */
  instructions: string;
}

export async function prepareCart(deps: PurchaseDeps, input: PrepareInput): Promise<PrepareResult> {
  const now = deps.now?.() ?? Date.now();
  if (!input.items.length) throw new Error("A cart needs at least one item.");

  const stores = new Set(
    input.items.map((i) => {
      const parsed = parseStoreOf(deps.registry, i.id);
      if (!parsed) throw new Error(`No such product id "${i.id}".`);
      return parsed;
    }),
  );
  if (stores.size > 1) {
    // One mandate = one merchant checkout. A basket spanning two retailers is
    // two approvals, because it is two carts and two prices that can drift.
    throw new Error(
      `Items span ${stores.size} stores (${[...stores].join(", ")}). Prepare one cart per store.`,
    );
  }

  const storeId = [...stores][0]!;
  const adapter = deps.registry.get(storeId)!;
  if (!adapter.buildCart) {
    throw new Error(`Store "${storeId}" cannot build a cart. It reaches only ${adapter.manifest.capabilities.join(", ")}.`);
  }

  /*
   * Session stores (Tesco today) need a sealed vault credential before we hit
   * the retailer's API. Failing here with a Connect-panel pointer beats a raw
   * 401 that looks like a network bug.
   */
  if (storeNeedsSession(storeId)) {
    const held = deps.vault?.get(storeId) ?? null;
    if (!held || held.broken || held.expired) {
      const why = held?.expired
        ? "the connected session has expired"
        : held?.broken
          ? "the stored credential cannot be read"
          : "no account is connected";
      throw new Error(
        `${adapter.manifest.name} trolley needs a connected session (${why}). ` +
          `Open the Basketed panel → Connect stores → ${adapter.manifest.name}, press Connect, ` +
          `sign in on ${adapter.manifest.domain ?? "the retailer site"} if asked.`,
      );
    }
  }

  // Vault-wrapped only for THIS store's id -- a store with no stored
  // credential gets deps.ctx.http back unchanged (authorizedFetch no-ops).
  const cartCtx = deps.vault ? { ...deps.ctx, http: authorizedFetch(deps.vault, storeId, deps.ctx.http) } : deps.ctx;
  const raw = await withRetryCart(() => adapter.buildCart!(input.items, cartCtx));
  const lineItems: MandateLine[] = raw.lineItems.map((li) => ({
    id: li.id,
    variantId: li.variantId,
    name: li.name,
    quantity: li.quantity,
    unitPrice: li.unitPrice,
  }));

  const route = resolveRoute(raw.handoffUrl, adapter.manifest.mode, adapter.manifest.name, adapter.manifest.domain);

  const mandate: CartMandate = {
    storeId,
    accountHandle: input.accountHandle,
    cartId: raw.cartId,
    lineItems,
    adjustments: raw.adjustments,
    subtotal: raw.subtotal,
    total: raw.total,
    handoffUrl: raw.handoffUrl,
    routeRung: route.rung,
    mode: adapter.manifest.mode,
    ...(input.addressId ? { addressId: input.addressId } : {}),
  };

  const hash = cartHash(mandate);
  const id = mintApprovalId();
  const code = mintCode();
  const salt = randomBytes(16).toString("hex");
  const expiresAt = now + APPROVAL_TTL_MS;

  deps.db
    .prepare(
      `INSERT INTO approvals
         (id, principal, state, store_id, account_handle, cart_id, cart_hash, cart_json,
          total_value, total_currency, code_hash, code_salt, created_at, expires_at)
       VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.principal,
      storeId,
      input.accountHandle,
      raw.cartId,
      hash,
      JSON.stringify(mandate),
      raw.total.value,
      raw.total.currency,
      hashCode(code, salt),
      salt,
      now,
      expiresAt,
    );

  audit(deps.db, "cart_prepared", `${fingerprint(id)} ${storeId} ${money(raw.total)}`, now);

  const summary = describeMandate(mandate);
  deps.announce(consoleBanner(adapter.manifest.name, mandate, summary, code, route));
  // The banner is the code; this is the link. Both land on the console.
  deps.summon?.(id);

  return {
    approvalId: id,
    approveUrl: `${deps.panelBase ?? "http://127.0.0.1:8787"}/approvals/${id}`,
    expiresAt: new Date(expiresAt).toISOString(),
    mandate,
    cartHash: hash,
    summary,
    instructions:
      "NOT YET APPROVED and nothing has been charged. A 6-digit approval code has been printed on the " +
      "Basketed server's own console, where no agent can read it. Ask the person you are working for to " +
      "read it out, then call basket_purchase_confirm with that code. They can also approve at the " +
      "approve_url. The code expires in 5 minutes.",
  };
}

function money(m: Money): string {
  return `${m.value.toFixed(2)} ${m.currency}`;
}

function consoleBanner(
  storeName: string,
  mandate: CartMandate,
  summary: string[],
  code: string,
  route: PurchaseRoute,
): string[] {
  const stamp = mandate.mode === "simulated" ? "  [SIMULATED — no real order]" : "";
  return [
    "",
    "==================== BASKETED — APPROVAL REQUIRED ====================",
    `  ${storeName}${stamp}`,
    ...summary.map((s) => `    ${s}`),
    "  ------------------------------------------------------------------",
    `  TOTAL                    ${money(mandate.total)}`,
    "",
    `  APPROVAL CODE: ${code.slice(0, 3)} ${code.slice(3)}      (valid 5 minutes)`,
    "",
    "  Read this code to the agent to authorise. Nothing is charged until",
    `  you do. Route: ${describeRoute(route)}`,
    "======================================================================",
    "",
  ];
}

function resolveRoute(handoffUrl: string | null, mode: string, name: string, domain?: string): PurchaseRoute {
  if (handoffUrl) {
    return {
      rung: 1,
      url: handoffUrl,
      reach: "Real server-side cart at the merchant. The human completes payment on the merchant's own checkout page.",
      unverified: false,
    };
  }
  if (mode === "simulated") {
    return {
      rung: 4,
      url: domain ? `https://${domain}` : "",
      reach: `SIMULATED store (${name}). No real cart and no real checkout exists behind this.`,
      unverified: false,
    };
  }
  return productDeepLink(domain ? `https://${domain}` : "", name);
}

function parseStoreOf(registry: StoreRegistry, productId: string): string | null {
  for (const adapter of registry.all()) {
    // Adapters cache the ids they minted, so membership is the authoritative
    // check -- it also means an id from a store that has not been searched in
    // this process is correctly rejected rather than half-resolved.
    if (productId.startsWith(`bk_${adapter.manifest.id.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}_`)) {
      return adapter.manifest.id;
    }
  }
  return null;
}

/* -------------------------------------------------------- the approval act */

export type ApprovalChannel = "console" | "panel";

export interface ApproveResult {
  ok: boolean;
  reason?: string;
  state: ApprovalState;
  attemptsLeft?: number;
}

/**
 * The single function every approval channel converges on (§6).
 *
 * Console code, panel click and (later) client elicitation all land here, so
 * the security properties are identical regardless of where the human clicked.
 * What varies is only the evidence: a code the model cannot read, a click on a
 * separately-authenticated page, or a client-rendered dialog the model does
 * not author.
 */
export function approveApproval(
  deps: PurchaseDeps,
  approvalId: string,
  principal: string,
  evidence: { channel: ApprovalChannel; code?: string; typedTotal?: string },
): ApproveResult {
  const now = deps.now?.() ?? Date.now();
  const row = readApproval(deps.db, approvalId);

  // An unknown handle and a handle belonging to somebody else are answered
  // identically. Distinguishing them would confirm that a guessed id exists.
  if (!row || row.principal !== principal) {
    return { ok: false, reason: "No such approval.", state: "EXPIRED" };
  }
  if (row.state !== "PENDING") {
    return { ok: false, reason: `Approval is already ${row.state}.`, state: row.state };
  }
  if (row.expires_at <= now) {
    deps.db.prepare("UPDATE approvals SET state = 'EXPIRED' WHERE id = ?").run(approvalId);
    audit(deps.db, "approval_expired", fingerprint(approvalId), now);
    return { ok: false, reason: "Approval expired. Prepare the cart again.", state: "EXPIRED" };
  }

  /*
   * One attempt budget, shared by both channels.
   *
   * The console channel locked after five wrong codes. The panel channel
   * counted nothing at all, so its evidence -- the exact total -- could be
   * guessed at leisure by anything that could reach the route. There is no
   * version of this where one human channel is cheap to brute-force and the
   * other is not, so the limit moved out of the console branch.
   */
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    deps.db.prepare("UPDATE approvals SET state = 'REJECTED' WHERE id = ? AND state = 'PENDING'").run(approvalId);
    audit(deps.db, "approval_locked", fingerprint(approvalId), now);
    return { ok: false, reason: "Too many wrong attempts. This approval is dead.", state: "REJECTED" };
  }

  /*
   * One statement, not read-then-write: two processes sharing the database file
   * would otherwise both read 4, both write 5, and hand out a free sixth guess.
   */
  const wrong = (event: string, reason: string): ApproveResult => {
    const bumped = deps.db
      .prepare("UPDATE approvals SET attempts = attempts + 1 WHERE id = ? RETURNING attempts")
      .all(approvalId) as unknown as Array<{ attempts: number }>;
    const attempts = Number(bumped[0]?.attempts ?? row.attempts + 1);
    audit(deps.db, event, `${fingerprint(approvalId)} attempt ${attempts}`, now);
    return { ok: false, reason, state: "PENDING", attemptsLeft: Math.max(0, MAX_CODE_ATTEMPTS - attempts) };
  };

  if (evidence.channel === "console") {
    if (!evidence.code || !codeMatches(evidence.code, row)) {
      return wrong("approval_code_wrong", "That code is not correct.");
    }
  }

  if (evidence.channel === "panel") {
    // The panel makes the human retype the total, so the thing they confirm is
    // the number itself rather than the position of a button.
    const expected = `${row.total_value.toFixed(2)}`;
    const typed = (evidence.typedTotal ?? "").replace(/[^\d.]/g, "");
    if (typed !== expected) {
      return wrong("approval_total_wrong", "The typed total does not match this cart.");
    }
  }

  const applied = deps.db
    .prepare(
      "UPDATE approvals SET state = 'APPROVED', approved_at = ?, approved_channel = ?, approved_total = ? WHERE id = ? AND state = 'PENDING'",
    )
    .run(now, evidence.channel, `${row.total_value.toFixed(2)} ${row.total_currency}`, approvalId);

  // The WHERE clause is the guard, so the row count is the answer. Announcing
  // an approval this statement did not make would tell a person their click
  // landed on a cart another writer had already moved.
  if (Number(applied.changes) === 0) {
    const current = readApproval(deps.db, approvalId)?.state ?? "EXPIRED";
    return { ok: false, reason: `Approval is already ${current}.`, state: current };
  }

  audit(deps.db, "approved", `${fingerprint(approvalId)} via ${evidence.channel}`, now);
  return { ok: true, state: "APPROVED" };
}

export function rejectApproval(deps: PurchaseDeps, approvalId: string, principal: string): ApproveResult {
  const now = deps.now?.() ?? Date.now();
  const row = readApproval(deps.db, approvalId);
  if (!row || row.principal !== principal) return { ok: false, reason: "No such approval.", state: "EXPIRED" };

  const applied = deps.db
    .prepare("UPDATE approvals SET state = 'REJECTED' WHERE id = ? AND state = 'PENDING'")
    .run(approvalId);

  // Only a PENDING approval can be rejected, and this used to return ok: true
  // without ever asking whether it had rejected one. Telling a person that a
  // purchase they tried to call off is dead, when it was already CONSUMED, is
  // the single worst lie this surface could tell.
  if (Number(applied.changes) === 0) {
    return { ok: false, reason: `Approval is already ${row.state}.`, state: row.state };
  }

  audit(deps.db, "rejected", fingerprint(approvalId), now);
  return { ok: true, state: "REJECTED" };
}

/* ------------------------------------------------------ purchase_confirm */

export interface ConfirmResult {
  ok: boolean;
  reason?: string;
  orderId?: string;
  state?: OrderState;
  outcome?: string;
  handoffUrl?: string | null;
  route?: string;
  total?: Money;
  guardrails?: GuardrailVerdict["checks"];
  /** What the human is expected to do next, when the route ends in their browser. */
  next?: string;
}

export async function confirmPurchase(
  deps: PurchaseDeps,
  approvalId: string,
  principal: string,
): Promise<ConfirmResult> {
  const now = deps.now?.() ?? Date.now();

  /*
   * Consumption is ONE atomic statement. A read-then-write would leave a race
   * where two concurrent confirms both see APPROVED and both execute; zero
   * rows returned here is the whole concurrency story.
   *
   * The principal is part of the WHERE clause, not a check afterwards:
   * possession of the handle is never sufficient (2026-07-28 State Handle
   * Hijacking).
   */
  const consumed = deps.db
    .prepare(
      `UPDATE approvals SET state = 'CONSUMED', consumed_at = ?
        WHERE id = ? AND principal = ? AND state = 'APPROVED' AND expires_at > ?
        RETURNING *`,
    )
    .all(now, approvalId, principal, now) as unknown as ApprovalRow[];

  if (consumed.length === 0) {
    const row = readApproval(deps.db, approvalId);
    audit(deps.db, "confirm_refused", `${fingerprint(approvalId)} state=${row?.state ?? "none"}`, now);
    return { ok: false, reason: refusalFor(row, principal, now) };
  }

  const row = consumed[0]!;
  const mandate = JSON.parse(row.cart_json) as CartMandate;

  // Re-hash from the stored mandate. If a price moved after the human looked
  // at it, the approval covers a cart that no longer exists.
  const rehashed = cartHash(mandate);
  if (rehashed !== row.cart_hash) {
    audit(deps.db, "hash_drift", fingerprint(approvalId), now);
    return {
      ok: false,
      reason:
        "The cart changed after it was approved, so the approval no longer covers it. " +
        "Prepare it again and have a human approve the new total.",
    };
  }

  const guardrails: Guardrails = loadGuardrails(deps.db);
  const verdict = evaluateGuardrails(deps.db, mandate, guardrails, deps.fx, now);
  if (!verdict.allowed) {
    audit(deps.db, "guardrail_refused", `${fingerprint(approvalId)} ${verdict.reason}`, now);
    // The approval is already spent. A refused execution does not hand it
    // back -- retrying needs a fresh human.
    return { ok: false, reason: verdict.reason!, guardrails: verdict.checks };
  }

  const orderId = `ord_${randomBytes(9).toString("base64url")}`;
  const adapter = deps.registry.get(mandate.storeId);
  const simulated = mandate.mode === "simulated";

  let state: OrderState;
  let outcome: string;
  let handoffUrl: string | null = mandate.handoffUrl;
  let next: string;

  if (simulated) {
    // A simulated store completes to a clearly-stamped simulated order. It
    // never borrows the language of a real one.
    state = "PLACED";
    outcome = "simulated";
    handoffUrl = null;
    next = "SIMULATED order. Nothing was bought and no money moved.";
  } else if (handoffUrl) {
    state = "HANDED_OFF";
    // We genuinely do not know whether the human completed it. Saying so is
    // the point; a green tick here would be the most damaging bug we ship.
    outcome = "unknown";
    next =
      "Open this URL to finish the purchase on the merchant's own checkout page. Basketed never takes " +
      "payment and does not know whether you completed it — the order stays 'handed off, outcome unknown' " +
      "until you confirm it in the panel or an order lookup succeeds.";
  } else {
    state = "FAILED";
    outcome = "no_route";
    next = `No cart route exists for ${mandate.storeId}. Nothing was attempted.`;
  }

  deps.db
    .prepare(
      `INSERT INTO orders
         (id, approval_id, store_id, state, outcome, total_value, total_currency,
          handoff_url, route_rung, cart_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      orderId,
      approvalId,
      mandate.storeId,
      state,
      outcome,
      mandate.total.value,
      mandate.total.currency,
      handoffUrl,
      mandate.routeRung,
      row.cart_json,
      now,
      now,
    );

  // Only a route that could actually reach a payment page counts against the
  // caps. A simulated order spends nothing and must not consume the budget.
  if (!simulated && state !== "FAILED") {
    recordSpend(deps.db, approvalId, verdict.normalisedTotal.value, guardrails.homeCurrency, now);
  }

  audit(deps.db, "order_created", `${fingerprint(approvalId)} ${orderId} ${state}/${outcome}`, now);

  return {
    ok: state !== "FAILED",
    orderId,
    state,
    outcome,
    handoffUrl,
    route: describeRoute(resolveRoute(handoffUrl, mandate.mode, adapter?.manifest.name ?? mandate.storeId, adapter?.manifest.domain)),
    total: mandate.total,
    guardrails: verdict.checks,
    next,
  };
}

function refusalFor(row: ApprovalRow | undefined, principal: string, now: number): string {
  if (!row || row.principal !== principal) return "No such approval.";
  if (row.state === "PENDING") {
    return (
      "This purchase has not been approved by a human yet. A 6-digit code was printed on the Basketed " +
      "server's console when the cart was prepared — ask for it and pass it as `code`, or approve at the " +
      "approve_url. There is no way for an agent to approve its own purchase."
    );
  }
  if (row.state === "CONSUMED") return "That approval has already been used. Approvals are single-use.";
  if (row.state === "REJECTED") return "That purchase was rejected.";
  if (row.expires_at <= now) return "That approval expired. Prepare the cart again.";
  return `Approval is ${row.state}.`;
}

/* ------------------------------------------------------------------ reads */

export function listOrders(db: Db, limit = 20): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT id, store_id, state, outcome, total_value, total_currency, handoff_url, route_rung, created_at
         FROM orders ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
}

export function getOrder(db: Db, orderId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as Record<string, unknown> | undefined;
}

/**
 * Move a handed-off order onto a real state. **Human action only.**
 *
 * There is deliberately no MCP tool for this, for the same reason there is no
 * tool that approves: when the route ends in the human's own browser we
 * genuinely do not know the outcome, and letting the agent assert one would let
 * it manufacture a completed order out of nothing. Only the panel calls this.
 */
export function markOrderOutcome(
  db: Db,
  orderId: string,
  state: Extract<OrderState, "CONFIRMED" | "CANCELLED">,
  now = Date.now(),
): boolean {
  const changed = db
    .prepare(
      `UPDATE orders SET state = ?, outcome = ?, updated_at = ?
        WHERE id = ? AND state = 'HANDED_OFF'`,
    )
    .run(state, state === "CONFIRMED" ? "confirmed_by_human" : "cancelled_by_human", now, orderId);
  if (changed.changes) audit(db, "order_outcome", `${orderId} -> ${state} by human`, now);
  return changed.changes > 0;
}

export function listPendingApprovals(db: Db, principal: string, now = Date.now()): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT id, store_id, total_value, total_currency, created_at, expires_at, cart_json
         FROM approvals WHERE principal = ? AND state = 'PENDING' AND expires_at > ?
         ORDER BY created_at DESC`,
    )
    .all(principal, now) as Array<Record<string, unknown>>;
}
