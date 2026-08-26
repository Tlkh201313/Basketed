import {
  approveApproval,
  rejectApproval,
  listOrders,
  listPendingApprovals,
  markOrderOutcome,
  loadGuardrails,
  saveGuardrails,
  GuardrailValueError,
  spentInWindow,
  type CartMandate,
} from "@basketed/commerce";
import type { ControlDeps } from "./types.js";

/**
 * The panel's REST surface — approval channel A (§6).
 *
 * This is a SEPARATE channel from the MCP one, and that separation is most of
 * the security property -- but the route split is not what enforces it. Every
 * client Basketed installs into has a shell, so reaching these paths was never
 * beyond an agent. What is beyond it is the panel token these routes sit
 * behind, which is minted per process and printed on the server's own console.
 * See the gate in `./index.ts`.
 *
 * Same `approveApproval()` underneath, so the guarantees are identical wherever
 * the human clicked.
 */

export interface ApiResult {
  status: number;
  body: unknown;
}

/** A list of strings, or null if the caller sent something else. */
function asList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.some((v) => typeof v !== "string")) return null;
  return raw as string[];
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
    if (payload["home_currency"] !== undefined) next["homeCurrency"] = String(payload["home_currency"]);
    if (payload["per_order_cap"] !== undefined) next["perOrderCap"] = Number(payload["per_order_cap"]);
    if (payload["daily_cap"] !== undefined) next["dailyCap"] = Number(payload["daily_cap"]);

    /*
     * The two allowlists had no write route at all, so they could only ever
     * hold their default. An empty store allowlist means "any registered
     * store", which made the guardrail unreachable rather than merely unset --
     * while `evaluateGuardrails` checked it on every single confirm.
     *
     * Store ids are checked against the registry here rather than inside
     * `saveGuardrails`, which has no registry to check against. An allowlist
     * naming a store that does not exist is a typo that silently refuses
     * everything, and that is the failure this route must not ship.
     */
    if (payload["allowed_stores"] !== undefined) {
      const wanted = asList(payload["allowed_stores"]);
      if (!wanted) return { status: 400, body: { error: "allowed_stores must be a list of store ids." } };
      const known = new Set(deps.registry.list().map((s) => s.id));
      const unknown = wanted.filter((id) => !known.has(id));
      if (unknown.length) {
        return { status: 400, body: { error: `No such store: ${unknown.join(", ")}. Use the ids from /api/state.` } };
      }
      next["allowedStores"] = wanted;
    }

    // Nothing can put an address on a cart today -- there is no MCP tool for it
    // and the panel does not offer one -- so this list guards a field that is
    // always null. It is settable because the guardrail reading it is live, and
    // a dormant check with no way to arm it is worse than either alternative.
    if (payload["allowed_addresses"] !== undefined) {
      const wanted = asList(payload["allowed_addresses"]);
      if (!wanted) return { status: 400, body: { error: "allowed_addresses must be a list of address ids." } };
      next["allowedAddresses"] = wanted;
    }

    try {
      saveGuardrails(purchase.db, next);
    } catch (err) {
      // A refused write says why, in words the panel can show. `Number("abc")`
      // is NaN, and a NaN written here would read back as the DEFAULT cap --
      // the user would be running 250 while the panel showed what they typed.
      if (err instanceof GuardrailValueError) return { status: 400, body: { error: err.message } };
      throw err;
    }
    return { status: 200, body: loadGuardrails(purchase.db) };
  }

  return null;
}
