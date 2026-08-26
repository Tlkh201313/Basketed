import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AdapterCtx } from "../types.js";

/**
 * Shopify UCP transport (§4).
 *
 * Everything in here was verified live before it was written. The three facts
 * that cost the most to discover, recorded so nobody rediscovers them:
 *
 *  1. The agent profile URI goes in `arguments.meta["ucp-agent"].profile` --
 *     inside the tool arguments, NOT in JSON-RPC `params._meta`. The wrong
 *     placement yields `invalid_profile_url` / "Missing profile uri", which
 *     reads like a hosting problem and is not one.
 *  2. The profile host must serve `content-type: application/json`.
 *     raw.githubusercontent.com and gist raw both serve text/plain and are
 *     REJECTED with `profile_malformed` / "Invalid content type".
 *  3. Prices are integer minor units. 1999 is $19.99.
 *
 * The error ladder is diagnostic: missing uri -> wrong placement; invalid
 * content type -> wrong host; invalid cache control -> wrong headers.
 */

export const DEFAULT_UCP_PROFILE =
  "https://cdn.statically.io/gist/Tlkh201313/1d42ef351a9075c75901f539bae847bc/raw/ucp-profile.json";

export function ucpProfile(): string {
  return process.env.BASKETED_UCP_PROFILE ?? DEFAULT_UCP_PROFILE;
}

export const UCP_API_VERSION = "2026-04-08";

const USER_AGENT = "Basketed/0.1 (+https://github.com/Tlkh201313/basketed) universal-shopping-mcp";

export class UcpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Present on most failures -- somewhere to send the human even when we failed. */
    readonly continueUrl: string | null = null,
  ) {
    super(message);
    this.name = "UcpError";
  }
}

export interface UcpCallOptions {
  /** Snapshot basename to replay from when ctx.snapshots is set. */
  snapshotKey?: string;
}

/** Raw byte count of the last response, kept for the honest benchmark baseline. */
export interface UcpResponse<T = Record<string, unknown>> {
  payload: T;
  rawBytes: number;
}

function parseBody(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Some endpoints answer as SSE; take the first data: frame.
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    if (!line) throw new UcpError("Unparseable UCP response", "unparseable");
    return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
  }
}

/**
 * Find the URL a human uses to finish the purchase.
 *
 * `continue_url` is confirmed against live carts and is the field we expect.
 * The fallback chain exists because this is the single most load-bearing field
 * in the build -- if it is ever absent or renamed, purchase_confirm returns
 * something useless -- and because it warns loudly, a rename shows up as a log
 * line rather than as a broken demo.
 */
export function resolveHandoffUrl(
  payload: Record<string, unknown>,
  log?: AdapterCtx["log"],
): string | null {
  const direct =
    (payload["continue_url"] as string | undefined) ??
    ((payload["cart"] as Record<string, unknown> | undefined)?.["continue_url"] as string | undefined) ??
    ((payload["checkout"] as Record<string, unknown> | undefined)?.["continue_url"] as string | undefined) ??
    (payload["checkout_url"] as string | undefined);
  if (typeof direct === "string" && direct.startsWith("http")) return direct;

  const blob = JSON.stringify(payload);
  const guess = blob.match(/"(https:\/\/[^"]*\/(?:cart|checkouts?)\/[^"]*)"/)?.[1];
  if (guess) {
    log?.("continue_url absent; fell back to a URL match. The field may have been renamed.", {
      matched: guess.slice(0, 80),
    });
    return guess;
  }
  return null;
}

export interface UcpClientOptions {
  endpoint: string;
  domain: string;
}

export class UcpClient {
  constructor(private readonly opts: UcpClientOptions) {}

  private snapshotPath(key: string, tool: string): string {
    const kind = tool.includes("cart") ? "cart" : "search";
    return resolve(process.cwd(), "fixtures/snapshots", `${key}.${kind}.json`);
  }

  async call<T = Record<string, unknown>>(
    tool: string,
    args: Record<string, unknown>,
    ctx: AdapterCtx,
    opts: UcpCallOptions = {},
  ): Promise<UcpResponse<T>> {
    if (ctx.snapshots && opts.snapshotKey) {
      const path = this.snapshotPath(opts.snapshotKey, tool);
      const file = JSON.parse(await readFile(path, "utf8")) as UcpResponse<T>;
      ctx.log(`replaying snapshot ${path}`);
      return { payload: file.payload, rawBytes: file.rawBytes };
    }

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: tool,
        arguments: { meta: { "ucp-agent": { profile: ucpProfile() } }, ...args },
      },
    });

    const res = await ctx.http(this.opts.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": USER_AGENT,
      },
      body,
    });

    const text = await res.text();

    // Rate limits are unpublished; there is no Retry-After to honour, so back
    // off blind rather than hammering a store we do not own.
    if (res.status === 429) {
      throw new UcpError(`${this.opts.domain} rate-limited (429)`, "rate_limited");
    }

    const json = parseBody(text);

    if (json["error"]) {
      const err = json["error"] as { message?: string; data?: Record<string, unknown> };
      const data = err.data ?? {};
      throw new UcpError(
        `${this.opts.domain} ${tool}: ${String(data["content"] ?? err.message ?? "unknown error")}`,
        String(data["code"] ?? "ucp_error"),
        (data["continue_url"] as string | undefined) ?? null,
      );
    }

    const result = json["result"] as
      | { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }
      | undefined;

    const block = result?.content?.[0];

    if (result?.isError) {
      throw new UcpError(`${this.opts.domain} ${tool}: ${block?.text ?? "tool error"}`, "tool_error");
    }

    const payload = (block?.text ? JSON.parse(block.text) : result?.structuredContent) as T;
    if (!payload) throw new UcpError(`${this.opts.domain} ${tool}: empty payload`, "empty");

    return { payload, rawBytes: text.length };
  }
}
