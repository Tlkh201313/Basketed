import { createRedactor, type Redactor } from "@basketed/core";
import {
  StoreRegistry,
  SimulatedAdapter,
  loadPinnedShopifyStores,
  type AdapterCtx,
} from "@basketed/adapters";

/**
 * Everything the tool handlers need, built ONCE per process.
 *
 * This exists because both transports use a per-request server factory: the
 * SDK builds a fresh `McpServer` for every inbound request so the server stays
 * stateless under MCP 2026-07-28. Loading the pinned store list and the
 * simulated catalog from disk inside that factory would re-read both files on
 * every tool call. The factory is therefore cheap and this is not.
 */
export interface Runtime {
  registry: StoreRegistry;
  ctx: AdapterCtx;
  redactor: Redactor;
  ledger: TokenLedger;
  /** Which stores were loaded, for the startup banner on stderr. */
  summary: string;
}

/**
 * Cumulative token accounting for `get_token_report` (§3.2b).
 *
 * Deliberately a running total for the session rather than a per-call figure:
 * the claim we make is about what an agent spends over a shopping task, and a
 * single flattering call is not that.
 */
export class TokenLedger {
  #served = 0;
  #baseline = 0;
  #calls = 0;
  #byTool = new Map<string, { calls: number; served: number; baseline: number }>();

  record(tool: string, served: number, baseline: number): void {
    this.#served += served;
    this.#baseline += baseline;
    this.#calls += 1;
    const row = this.#byTool.get(tool) ?? { calls: 0, served: 0, baseline: 0 };
    row.calls += 1;
    row.served += served;
    row.baseline += baseline;
    this.#byTool.set(tool, row);
  }

  report() {
    const saved = this.#baseline - this.#served;
    return {
      calls: this.#calls,
      tokens_served: this.#served,
      tokens_baseline: this.#baseline,
      tokens_saved: saved > 0 ? saved : 0,
      saved_pct: this.#baseline > 0 ? Number(((saved / this.#baseline) * 100).toFixed(1)) : 0,
      by_tool: Object.fromEntries(
        [...this.#byTool.entries()].map(([tool, r]) => [
          tool,
          {
            calls: r.calls,
            tokens_served: r.served,
            tokens_baseline: r.baseline,
            saved_pct: r.baseline > 0 ? Number((((r.baseline - r.served) / r.baseline) * 100).toFixed(1)) : 0,
          },
        ]),
      ),
      method:
        "baseline = raw upstream bytes we actually fetched, at ~3.6 chars/token. " +
        "Stores that fetched nothing (simulated) contribute nothing to either side.",
    };
  }
}

export interface RuntimeOptions {
  root?: string;
  /** Replay from fixtures/snapshots instead of the network. */
  snapshots?: boolean;
  /** Where adapter diagnostics go. NEVER stdout on the stdio transport. */
  log?: (msg: string) => void;
}

export async function createRuntime(opts: RuntimeOptions = {}): Promise<Runtime> {
  const root = opts.root ?? process.cwd();
  const snapshots = opts.snapshots ?? process.env["BASKETED_SNAPSHOTS"] === "1";
  // stdio owns stdout: a stray console.log there corrupts the JSON-RPC stream
  // and the client reports a parse error with no hint where it came from.
  const log = opts.log ?? ((msg: string) => process.stderr.write(`[basketed] ${msg}\n`));

  const registry = new StoreRegistry();
  const loaded: string[] = [];

  try {
    for (const adapter of await loadPinnedShopifyStores(root)) {
      registry.register(adapter);
      loaded.push(adapter.manifest.id);
    }
  } catch (err) {
    // A missing pin file must not take the server down -- the simulated stores
    // still answer, and list_stores tells the truth about what is present.
    log(`no pinned Shopify stores: ${(err as Error).message}`);
  }

  try {
    for (const adapter of await SimulatedAdapter.loadAll(root)) {
      registry.register(adapter);
      loaded.push(adapter.manifest.id);
    }
  } catch (err) {
    log(`no simulated catalog: ${(err as Error).message}`);
  }

  const redactor = createRedactor((report) => {
    // A redaction hit is a bug, not routine. It is loud on purpose.
    log(`REDACTION ALARM: ${report.count} hit(s) [${report.hits.join(", ")}]`);
  });

  const byMode = new Map<string, number>();
  for (const row of registry.list()) byMode.set(row.mode, (byMode.get(row.mode) ?? 0) + 1);

  return {
    registry,
    ctx: { http: fetch, log, snapshots },
    redactor,
    ledger: new TokenLedger(),
    summary:
      `${loaded.length} stores (` +
      [...byMode.entries()].map(([mode, n]) => `${n} ${mode}`).join(", ") +
      `)${snapshots ? " [SNAPSHOTS]" : ""}`,
  };
}
