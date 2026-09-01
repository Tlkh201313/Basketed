import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { estimateTokens, PROVENANCE_NOTE } from "@basketed/core";
import { authorizedFetch } from "@basketed/vault";
import type { Runtime } from "./runtime.js";

/**
 * Delivery windows on the wire — purchase lane.
 *
 * Listing needs a CONNECTED account (vault session). Booking is deliberately
 * not on the wire: see NEVER_ALLOW / basket_book_delivery_slot.
 *
 * Registered with the purchase tools (after auth_status) so the fetch lane
 * stays unsigned-search only.
 */

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
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

/** `YYYY-MM-DD`, the only date shape Tesco's slots range accepts. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function registerSlotTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    "basket_list_delivery_slots",
    {
      title: "List delivery slots",
      description:
        "Delivery windows a store can deliver in, with their charges. Requires a CONNECTED account: " +
        "no retailer shows a signed-out visitor its slots, so an unconnected store says so rather than " +
        "returning an empty list. Only bookable windows come back. Booking one is not an agent action -- " +
        "a human does it in the Basketed panel.",
      inputSchema: z.object({
        store_id: z.string().describe("A store id from list_stores, e.g. tsc:tesco"),
        start: z.string().regex(DATE).optional().describe("YYYY-MM-DD. Defaults to today."),
        end: z.string().regex(DATE).optional().describe("YYYY-MM-DD. Defaults to start + 7 days."),
      }),
      outputSchema: z
        .object({
          store_id: z.string(),
          range: z.object({ start: z.string(), end: z.string() }),
          slots: z.array(
            z.object({
              id: z.string(),
              start: z.string(),
              end: z.string(),
              available: z.boolean(),
              price: z.object({ value: z.number(), currency: z.string() }).nullable(),
            }),
          ),
        })
        .loose(),
      annotations: READ_ONLY,
    },
    async (args) => {
      const adapter = runtime.registry.get(args.store_id);
      if (!adapter) return respond(runtime, { error: `Store "${args.store_id}" is not loaded.` }, true);
      if (typeof adapter.slots !== "function") {
        return respond(
          runtime,
          { error: `${adapter.manifest.name} does not deliver on booked windows -- it has no slots to list.` },
          true,
        );
      }

      const now = Date.now();
      const start = args.start ?? isoDate(now);
      const end = args.end ?? isoDate(Date.parse(`${start}T00:00:00Z`) + 7 * 86_400_000);

      /*
       * The store's own session, or nothing. Slots are the clearest case in
       * the codebase for this: a signed-out request does not return fewer
       * slots, it returns a different (and useless) answer, so calling
       * unconnected and reporting the empty result as fact would be a lie
       * with a plausible shape.
       */
      const held = runtime.vault.get(args.store_id);
      if (!held || held.broken || held.expired) {
        const why = held?.expired ? "the connected session has expired" : "no account is connected";
        return respond(
          runtime,
          {
            error:
              `Cannot list ${adapter.manifest.name} delivery slots: ${why}. ` +
              `Connect the store in the Basketed panel, then ask again.`,
          },
          true,
        );
      }

      const ctx = { ...runtime.ctx, http: authorizedFetch(runtime.vault, args.store_id, runtime.ctx.http) };
      try {
        const slots = await adapter.slots({ start, end }, ctx);
        runtime.ledger.record(
          "basket_list_delivery_slots",
          estimateTokens(slots),
          adapter.lastRawBytes ? Math.ceil(adapter.lastRawBytes / 3.6) : 0,
        );
        return respond(runtime, {
          store_id: args.store_id,
          range: { start, end },
          slots,
          provenance: PROVENANCE_NOTE,
        });
      } catch (err) {
        return respond(runtime, { error: `Could not list slots: ${(err as Error).message}` }, true);
      }
    },
  );
}

export const SLOT_TOOL_NAMES = ["basket_list_delivery_slots"] as const;
