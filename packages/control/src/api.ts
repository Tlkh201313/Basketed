import {
  approveApproval,
  rejectApproval,
  listOrders,
  listPendingApprovals,
  markOrderOutcome,
  loadGuardrails,
  saveGuardrails,
  spentInWindow,
  type CartMandate,
} from "@basketed/commerce";
import type { ControlDeps } from "./types.js";

/**
 * The panel's REST surface — approval channel A (§6).
 *
 * This is a SEPARATE channel from the MCP one, and that separation is the
 * entire security property: the agent speaks JSON-RPC on /mcp and cannot reach
 * these routes, so an approval that arrives here provably did not come from the
 * model. Same `approveApproval()` underneath, so the guarantees are identical
 * wherever the human clicked.
 */

export interface ApiResult {
  status: number;
  body: unknown;
}

function mandateOf(row: Record<string, unknown>): CartMandate | null {
  try {
    return JSON.parse(String(row["cart_json"])) as CartMandate;
  } catch {
    return null;
  }
}

/** Everything the approval card renders, built ONLY from the mandate. */
function approvalView(row: Record<string, unknown>, now: number) {
  const mandate = mandateOf(row);
  return {
    id: String(row["id"]),
    store_id: String(row["store_id"]),
    mode: mandate?.mode ?? "unknown",
    total: { value: Number(row["total_value"]), currency: String(row["total_currency"]) },
    // Numeric and enumerated fields plus the normalized product name. No
    // description, no review, no merchant message reaches this screen -- which
    // is what stops injected vendor text from steering an approval.
    line_items: (mandate?.lineItems ?? []).map((li) => ({
      name: li.name,
      quantity: li.quantity,
      unit_price: li.unitPrice,
    })),
    adjustments: (mandate?.adjustments ?? []).map((a) => ({ label: a.label, amount: a.amount })),
    subtotal: mandate?.subtotal ?? null,
    route_rung: mandate?.routeRung ?? null,
    account_handle: String(row["account_handle"]),
    expires_in_ms: Math.max(0, Number(row["expires_at"]) - now),
  };
}

export async function handleApi(
  deps: ControlDeps,
  method: string,
  path: string,
  body: () => Promise<Record<string, unknown>>,
): Promise<ApiResult | null> {
  const purchase = deps.purchase;
  const now = Date.now();

  if (method === "GET" && path === "/api/state") {
    const g = loadGuardrails(purchase.db);
    return {
      status: 200,
      body: {
        server: { name: "basketed", version: deps.version },
        stores: deps.registry.list().map((s) => ({
          id: s.id,
          name: s.name,
          country: s.country,
          currency: s.currency,
          mode: s.mode,
          status: s.status,
          capabilities: s.capabilities,
        })),
        summary: deps.summary,
        // Named plainly. A user reading the panel should never have to guess
        // whether the flag they set touches the purchase path.
        fast_mode: deps.policy.fastMode,
        fast_mode_scope: "read-only tools only — it is not reachable from the purchase path",
        tokens: deps.ledger.report(),
        guardrails: {
          ...g,
          spent_24h: Number(spentInWindow(purchase.db, 24 * 60 * 60 * 1000, now).toFixed(2)),
        },
        redaction_alarms: deps.redactionAlarms(),
      },
    };
  }

  if (method === "GET" && path === "/api/approvals") {
    const rows = listPendingApprovals(purchase.db, deps.principal, now);
    return { status: 200, body: { approvals: rows.map((r) => approvalView(r, now)), count: rows.length } };
  }

  const approve = /^\/api\/approvals\/([^/]+)\/approve$/.exec(path);
  if (method === "POST" && approve) {
    const payload = await body();
    const result = approveApproval(purchase, decodeURIComponent(approve[1]!), deps.principal, {
      channel: "panel",
      typedTotal: String(payload["typed_total"] ?? ""),
    });
    return { status: result.ok ? 200 : 409, body: result };
  }

  const reject = /^\/api\/approvals\/([^/]+)\/reject$/.exec(path);
  if (method === "POST" && reject) {
    const result = rejectApproval(purchase, decodeURIComponent(reject[1]!), deps.principal);
    return { status: result.ok ? 200 : 409, body: result };
  }

  if (method === "GET" && path === "/api/orders") {
    return { status: 200, body: { orders: listOrders(purchase.db, 50) } };
  }

  const outcome = /^\/api\/orders\/([^/]+)\/outcome$/.exec(path);
  if (method === "POST" && outcome) {
    const payload = await body();
    const want = String(payload["state"] ?? "");
    if (want !== "CONFIRMED" && want !== "CANCELLED") {
      return { status: 400, body: { error: "state must be CONFIRMED or CANCELLED." } };
    }
    // Only a human can move an order off HANDED_OFF. There is no MCP tool for
    // this, because the agent has no way to know what happened in the browser.
    const moved = markOrderOutcome(purchase.db, decodeURIComponent(outcome[1]!), want, now);
    return { status: moved ? 200 : 409, body: { ok: moved, state: moved ? want : undefined } };
  }

  if (method === "POST" && path === "/api/guardrails") {
    const payload = await body();
    const next: Record<string, unknown> = {};
    if (payload["home_currency"]) next["homeCurrency"] = String(payload["home_currency"]);
    if (payload["per_order_cap"] !== undefined) next["perOrderCap"] = Number(payload["per_order_cap"]);
    if (payload["daily_cap"] !== undefined) next["dailyCap"] = Number(payload["daily_cap"]);
    saveGuardrails(purchase.db, next);
    return { status: 200, body: loadGuardrails(purchase.db) };
  }

  return null;
}
