import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { estimateTokens, PROVENANCE_NOTE } from "@basketed/core";
import { needsAccountFor, sessionFetchFor, sessionState, sessionUnusableReason } from "@basketed/commerce";
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

/** Longest range worth asking a retailer for. No grocer books three months out. */
export const MAX_SLOT_SPAN_DAYS = 30;

const DAY_MS = 86_400_000;

function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Turns whatever the model sent into a real, bounded date range.
 *
 * The zod regex only proves the SHAPE of a date. `2026-02-30` and
 * `2026-13-01` both match it, and `Date.parse` returns NaN for them, which
 * used to travel onwards as the string "Invalid Date" -- or, when only `start`
 * was given, made `isoDate(NaN)` throw a RangeError out of the tool handler
 * with nothing in the message about the date that caused it. A model that
 * miscounts the days in February should get a sentence telling it so.
 *
 * The span cap is here rather than at the adapter because it is a fact about
 * asking politely, not about Tesco: an open-ended range is a request for
 * hundreds of windows the shopper will never read, and every one of them is
 * tokens.
 */
export function slotWindow(
  args: { start?: string | undefined; end?: string | undefined },
  now: number,
): { ok: true; start: string; end: string } | { ok: false; error: string } {
  const start = args.start ?? isoDate(now);
  const startAt = parseDay(start);
  if (startAt === null) return { ok: false, error: badDate("start", start) };

  const end = args.end ?? isoDate(startAt + 7 * DAY_MS);
  const endAt = parseDay(end);
  if (endAt === null) return { ok: false, error: badDate("end", end) };

  if (endAt < startAt) {
    return { ok: false, error: `The slot range ends before it starts: ${start} to ${end}.` };
  }
  const days = Math.round((endAt - startAt) / DAY_MS) + 1;
  if (days > MAX_SLOT_SPAN_DAYS) {
    return {
      ok: false,
      error:
        `That range covers ${days} days. Ask for at most ${MAX_SLOT_SPAN_DAYS} at a time -- ` +
        `no store books further out, and the extra windows are tokens the shopper never reads.`,
    };
  }
  return { ok: true, start, end };
}

/** Milliseconds at UTC midnight, or null if that is not a day on the calendar. */
function parseDay(value: string): number | null {
  if (!DATE.test(value)) return null;
  const at = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  // Date.parse accepts 2026-02-30 in some runtimes by rolling it into March.
  // Round-tripping is the only check that catches a day that never existed.
  return isoDate(at) === value ? at : null;
}

function badDate(which: string, value: string): string {
  return (
    `"${value}" is not a date on the calendar, so there is no ${which} to look from. ` +
    `Use YYYY-MM-DD, e.g. 2026-03-01.`
  );
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
        store_id: z.string().describe("A store id from list_stores, e.g. the one basket_list_stores gave you"),
        start: z.string().regex(DATE).optional().describe("YYYY-MM-DD. Defaults to today."),
        end: z
          .string()
          .regex(DATE)
          .optional()
          .describe(`YYYY-MM-DD. Defaults to start + 7 days. At most ${MAX_SLOT_SPAN_DAYS} days from start.`),
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

      const window = slotWindow(args, Date.now());
      if (!window.ok) return respond(runtime, { error: window.error }, true);
      const { start, end } = window;

      /*
       * The store's own session, or nothing. Slots are the clearest case in
       * the codebase for this: a signed-out request does not return fewer
       * slots, it returns a different (and useless) answer, so calling
       * unconnected and reporting the empty result as fact would be a lie
       * with a plausible shape.
       */
      if (needsAccountFor(adapter.manifest.account, "slots")) {
        const held = runtime.vault.get(args.store_id);
        if (sessionState(held) !== "live") {
          return respond(
            runtime,
            {
              error:
                `Cannot list ${adapter.manifest.name} delivery slots: ` +
                `${sessionUnusableReason(held)}. ` +
                `Connect the store in the Basketed panel, then ask again.`,
            },
            true,
          );
        }
      }

      // Slots are a gated tier wherever they exist, so this resolves to the
      // strict wrapper -- but it resolves it from the manifest rather than
      // assuming it, so a store that ever offers anonymous slots gets them.
      const ctx = {
        ...runtime.ctx,
        http: sessionFetchFor(adapter.manifest, "slots", runtime.vault, runtime.ctx.http, runtime.ctx.log),
      };
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
