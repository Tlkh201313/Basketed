import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  addToBasket,
  confirmPurchase,
  getOrder,
  listOrders,
  prepareCart,
  approveApproval,
  type PurchaseDeps,
} from "@basketed/commerce";
import type { Runtime } from "./runtime.js";

/**
 * The money-adjacent tools (§3.4).
 *
 * Three properties hold here and are tested rather than asserted:
 *
 *  1. There is no tool that approves anything. No `approve`, no
 *     `approved: true`, no override flag. `basket_purchase_confirm` carries a
 *     `code` the human read off the server's own console -- it transports the
 *     human's evidence, it does not author it, and the server verifies it
 *     against a salted hash it never hands back.
 *  2. `destructiveHint` is true and these can never be promoted to ALLOW.
 *     The annotation is a UI hint the spec says clients MUST treat as
 *     untrusted, so the actual enforcement is in commerce, not here.
 *  3. `set_delivery_address` does not exist. There is no reason an agent needs
 *     to change where things are delivered, and removing the tool removes the
 *     whole class of attack. Addresses are managed in the panel, against an
 *     allowlist.
 *
 * Shopping mode (S24) sits in front of the gate. In BASKET mode -- the only
 * mode this build unlocks -- `basket_add_to_cart` puts the items in the
 * shopper's own basket at the store and reports where it is; the shopper
 * checks out themselves. `basket_cart_prepare` and `basket_purchase_confirm`
 * refuse in that mode, in commerce, not here.
 */

/** Writes to an account the person connected, but can never charge it. */
const BASKET_ONLY = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const MONEY_ADJACENT = {
  readOnlyHint: false,
  destructiveHint: true,
  // Confirm is emphatically not idempotent: an approval is single-use, and a
  // client that retried on timeout must not be told it is safe to do so.
  idempotentHint: false,
  openWorldHint: true,
} as const;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function respond(runtime: Runtime, payload: Record<string, unknown>, isError = false): ToolResult {
  const { value } = runtime.redactor.redact(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

export function registerPurchaseTools(server: McpServer, runtime: Runtime): void {
  const deps = (): PurchaseDeps => {
    if (!runtime.purchase) {
      throw new Error("The purchase gate is not initialised on this runtime.");
    }
    return runtime.purchase;
  };

  /* 5 ---------------------------------------------------------- add_to_cart */

  server.registerTool(
    "basket_add_to_cart",
    {
      title: "Add to the shopper's own basket",
      description:
        "BASKET MODE, the default. Put the product(s) you found into the shopper's OWN basket at one store, " +
        "in the account they connected in the Basketed panel, and get back a report and the link to that " +
        "basket. Nothing is bought: the shopper opens their basket and checks out themselves on the " +
        "retailer's own page. Use this after search: pick the best match, add it, then tell the person " +
        "what you added, the total, and the `basket_url`. All items must come from ONE store. Requires " +
        "that store to be connected.",
      inputSchema: z.object({
        items: z
          .array(z.object({ id: z.string(), quantity: z.number().int().positive().max(99) }))
          .min(1)
          .describe("Product ids from search_products, all from the same store"),
        account_handle: z
          .string()
          .describe("An opaque handle for the connected account, e.g. acct_tsc_tesco. Never a credential."),
      }),
      outputSchema: z
        .object({
          basket_id: z.string(),
          store_id: z.string(),
          store_name: z.string(),
          mode: z.string(),
          total: z.object({ value: z.number(), currency: z.string() }),
          line_items: z.array(z.unknown()),
          summary: z.array(z.string()),
          basket_url: z.string().nullable(),
          charged: z.boolean(),
          report: z.string(),
        })
        .loose(),
      annotations: BASKET_ONLY,
    },
    async (args) => {
      try {
        const result = await addToBasket(deps(), {
          items: args.items,
          accountHandle: args.account_handle,
          principal: runtime.principal,
        });
        return respond(runtime, {
          basket_id: result.basketId,
          store_id: result.storeId,
          store_name: result.storeName,
          mode: result.mode,
          total: result.total,
          line_items: result.lineItems,
          summary: result.summary,
          basket_url: result.basketUrl,
          // A field, not only prose: no client can render this as an order.
          charged: false,
          report: result.report,
        });
      } catch (err) {
        return respond(runtime, { error: (err as Error).message, charged: false }, true);
      }
    },
  );

  /* 6 --------------------------------------------------------- cart_prepare */

  server.registerTool(
    "basket_cart_prepare",
    {
      title: "Prepare a cart for human approval",
      description:
        "PURCHASE MODE ONLY -- locked in this build; in basket mode this refuses and tells you to use " +
        "basket_add_to_cart instead. " +
        "Build a REAL cart at one store and freeze it as a Cart Mandate awaiting human approval. " +
        "Nothing is charged and no checkout is created. Returns an `approval_id`, an `approve_url`, and " +
        "the exact itemised total a human must authorise. A 6-digit code is printed on the Basketed " +
        "server's own console — you cannot read it; a person has to. All items must come from ONE store.",
      inputSchema: z.object({
        items: z
          .array(z.object({ id: z.string(), quantity: z.number().int().positive().max(99) }))
          .min(1)
          .describe("Product ids from search_products, all from the same store"),
        account_handle: z
          .string()
          .describe("An opaque handle from list_accounts, e.g. acct_guest_shp_gymshark. Never a credential."),
        address_id: z.string().optional().describe("An address id previously allowlisted in the panel"),
      }),
      outputSchema: z
        .object({
          approval_id: z.string(),
          approve_url: z.string(),
          expires_at: z.string(),
          store_id: z.string(),
          mode: z.string(),
          total: z.object({ value: z.number(), currency: z.string() }),
          line_items: z.array(z.unknown()),
          summary: z.array(z.string()),
          cart_hash: z.string(),
          charged: z.boolean(),
          instructions: z.string(),
        })
        .loose(),
      annotations: MONEY_ADJACENT,
    },
    async (args) => {
      try {
        const result = await prepareCart(deps(), {
          items: args.items,
          accountHandle: args.account_handle,
          principal: runtime.principal,
          ...(args.address_id ? { addressId: args.address_id } : {}),
        });
        return respond(runtime, {
          approval_id: result.approvalId,
          approve_url: result.approveUrl,
          expires_at: result.expiresAt,
          store_id: result.mandate.storeId,
          mode: result.mandate.mode,
          total: result.mandate.total,
          line_items: result.mandate.lineItems,
          summary: result.summary,
          cart_hash: result.cartHash,
          // Stated as a field, not only in prose, so a client rendering the
          // structured result cannot present this as a completed purchase.
          charged: false,
          instructions: result.instructions,
        });
      } catch (err) {
        return respond(runtime, { error: (err as Error).message, charged: false }, true);
      }
    },
  );

  /* 7 ----------------------------------------------------- purchase_confirm */

  server.registerTool(
    "basket_purchase_confirm",
    {
      title: "Confirm an approved purchase",
      description:
        "PURCHASE MODE ONLY -- locked in this build; refuses in basket mode. " +
        "Execute a cart that a HUMAN has approved. Supply the 6-digit code the person read off the " +
        "Basketed server's console, or omit it if they already approved in the panel. Succeeds only " +
        "against an unexpired, unconsumed approval whose cart hash still matches and whose spend " +
        "guardrails pass. Approvals are single-use and a failed execution does not return one — a retry " +
        "needs a fresh human approval. This cannot be bypassed in any mode, by any flag.",
      inputSchema: z.object({
        approval_id: z.string().describe("From cart_prepare"),
        code: z
          .string()
          .optional()
          .describe("The 6-digit code a person read off the server console. You cannot see it yourself."),
      }),
      outputSchema: z
        .object({
          ok: z.boolean(),
          order_id: z.string().optional(),
          state: z.string().optional(),
          outcome: z.string().optional(),
          handoff_url: z.string().nullable().optional(),
          route: z.string().optional(),
          total: z.object({ value: z.number(), currency: z.string() }).optional(),
          guardrails: z.array(z.unknown()).optional(),
          next: z.string().optional(),
          error: z.string().optional(),
        })
        .loose(),
      annotations: MONEY_ADJACENT,
    },
    async (args) => {
      try {
        // Channel C. The code is evidence a human produced on a surface the
        // model cannot read; this call transports it, it does not author it.
        if (args.code) {
          const approved = approveApproval(deps(), args.approval_id, runtime.principal, {
            channel: "console",
            code: args.code,
          });
          if (!approved.ok) {
            return respond(
              runtime,
              {
                ok: false,
                error: approved.reason,
                state: approved.state,
                ...(approved.attemptsLeft !== undefined ? { attempts_left: approved.attemptsLeft } : {}),
              },
              true,
            );
          }
        }

        const result = await confirmPurchase(deps(), args.approval_id, runtime.principal);
        if (!result.ok) {
          return respond(
            runtime,
            { ok: false, error: result.reason, ...(result.guardrails ? { guardrails: result.guardrails } : {}) },
            true,
          );
        }
        return respond(runtime, {
          ok: true,
          order_id: result.orderId,
          state: result.state,
          outcome: result.outcome,
          handoff_url: result.handoffUrl ?? null,
          route: result.route,
          total: result.total,
          guardrails: result.guardrails,
          next: result.next,
        });
      } catch (err) {
        return respond(runtime, { ok: false, error: (err as Error).message }, true);
      }
    },
  );

  /* 8 ------------------------------------------------------------ list_orders */

  server.registerTool(
    "basket_list_orders",
    {
      title: "List orders",
      description:
        "Orders created through the purchase gate. `HANDED_OFF` with `outcome: \"unknown\"` is its own " +
        "state and is NOT success — it means a human was handed a checkout page and we have no way to " +
        "know whether they completed it. Only a person, in the panel, can move an order off that state.",
      inputSchema: z.object({ limit: z.number().int().positive().max(100).optional() }),
      outputSchema: z.object({ orders: z.array(z.unknown()), count: z.number() }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const orders = listOrders(deps().db, args.limit ?? 20);
      return respond(runtime, { orders, count: orders.length });
    },
  );

  /* 9 ------------------------------------------------------- get_order_status */

  server.registerTool(
    "basket_get_order_status",
    {
      title: "Get order status",
      description:
        "Status of one order. Reports `handed_off` honestly when that is what happened — never as a " +
        "completed purchase.",
      inputSchema: z.object({ order_id: z.string() }),
      outputSchema: z
        .object({
          id: z.string().optional(),
          state: z.string().optional(),
          outcome: z.string().optional(),
          handoff_url: z.string().nullable().optional(),
          error: z.string().optional(),
        })
        .loose(),
      annotations: READ_ONLY,
    },
    async (args) => {
      const order = getOrder(deps().db, args.order_id);
      if (!order) return respond(runtime, { error: `No such order "${args.order_id}".` }, true);
      const { cart_json, approval_id, ...safe } = order as Record<string, unknown>;
      void cart_json;
      // The approval id is never returned. Possession of a handle is not
      // authentication, and handing one back through a read tool would make it
      // trivially observable in a shared transcript.
      void approval_id;
      return respond(runtime, safe);
    },
  );
}

export const PURCHASE_TOOL_NAMES = [
  "basket_add_to_cart",
  "basket_cart_prepare",
  "basket_purchase_confirm",
  "basket_list_orders",
  "basket_get_order_status",
] as const;
