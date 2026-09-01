import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { createRedactor, type FxTable, type Redactor } from "@basketed/core";
import {
  StoreRegistry,
  SimulatedAdapter,
  TescoAdapter,
  AmazonAdapter,
  IkeaAdapter,
  TargetAdapter,
  EtsyAdapter,
  EbayAdapter,
  BestBuyAdapter,
  loadPinnedShopifyStores,
  type AdapterCtx,
} from "@basketed/adapters";
import { openDb, type PurchaseDeps } from "@basketed/commerce";
import { openVault, degradedVault, type Vault } from "@basketed/vault";
import { createPolicy, type Policy } from "./policy.js";

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
  /**
   * Retailer credentials, encrypted at rest.
   *
   * Present on the runtime so the PANEL can write to it. Nothing on the MCP
   * side reads it: tool handlers never see a `Vault`, and the one function
   * that returns plaintext is called only by the request interceptor. Handing
   * an adapter a credential is not possible by construction -- `AdapterCtx`
   * has no field it could travel in.
   */
  vault: Vault;
  redactor: Redactor;
  ledger: TokenLedger;
  /**
   * Who is acting, derived from the local session and NEVER from anything the
   * agent supplied. An approval handle is bound to this at prepare time and
   * re-checked inside the atomic consume, so possession of a handle alone is
   * not authentication (2026-07-28 State Handle Hijacking).
   *
   * Stable per machine rather than per process, so a cart prepared by the
   * agent over stdio can be approved in the panel by the same human.
   */
  principal: string;
  /**
   * Read-only auto-confirmation policy. Lives here so the panel and the
   * install writers read the same list the server does -- and it is
   * deliberately inert on the purchase path: see policy.ts.
   */
  policy: Policy;
  /** The purchase gate. Absent only when a caller explicitly opts out of it. */
  purchase?: PurchaseDeps;
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
  /** SQLite path. ":memory:" in tests. */
  dbPath?: string;
  /**
   * Where the approval banner is printed.
   *
   * Defaults to the server's own stderr, which is the whole basis of approval
   * channel C: the model has no read access to it, so the only way it obtains
   * the code is for a human to read it out.
   */
  announce?: (lines: string[]) => void;
  /** Skips per-call confirmation for read-only tools. Never anything else. */
  fastMode?: boolean;
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

  // Real Tesco (S16). Registered even under --snapshots -- unlike Shopify UCP
  // and the simulated stores, it has no fixture/snapshot mode of its own, so
  // it always calls the real network. The offline drill therefore excludes it
  // by store id rather than expecting it to replay: see drill-offline.mjs.
  try {
    registry.register(new TescoAdapter());
    loaded.push("tsc:tesco");
  } catch (err) {
    log(`tesco adapter unavailable: ${(err as Error).message}`);
  }

  // Real Amazon, IKEA, Target (S17). Discovery/detail only -- a stealth
  // browser renders their own public pages, there is no credential to hand
  // out for any of the three, and none of them has a fixture/snapshot mode,
  // so (like Tesco) they always call the real network and drill-offline.mjs
  // excludes them by store id rather than expecting them to replay.
  for (const build of [
    () => new AmazonAdapter(),
    () => new IkeaAdapter(),
    () => new TargetAdapter(),
    () => new EtsyAdapter(),
    () => new EbayAdapter(),
    () => new BestBuyAdapter(),
  ]) {
    try {
      const adapter = build();
      registry.register(adapter);
      loaded.push(adapter.manifest.id);
    } catch (err) {
      log(`scrape adapter unavailable: ${(err as Error).message}`);
    }
  }

  const redactor = createRedactor((report) => {
    // A redaction hit is a bug, not routine. It is loud on purpose.
    log(`REDACTION ALARM: ${report.count} hit(s) [${report.hits.join(", ")}]`);
  });

  const ctx: AdapterCtx = { http: fetch, log, snapshots };

  const fx = JSON.parse(await readFile(resolve(root, "fixtures/fx.json"), "utf8")) as FxTable;
  const db = openDb(opts.dbPath);

  // Every stored credential is handed to the redaction net as it is loaded, so
  // a value that somehow reaches a response is caught on the way out and
  // raises an alarm. It is the backstop, not the defence -- see vault/index.ts.
  //
  // Never let a bad key file take MCP down with it: search, cart and purchase
  // have nothing to do with this file, and a client that cannot start its MCP
  // server because ~/.basketed/master.key would not read is a much bigger
  // failure than a Connect-stores page that says so and refuses writes.
  let vault: Vault;
  try {
    vault = openVault(db, { watch: (secret) => redactor.watch(secret) });
  } catch (err) {
    const reason = (err as Error).message;
    log(`vault unavailable, connections disabled: ${reason}`);
    vault = degradedVault(reason);
  }
  const announce =
    opts.announce ?? ((lines: string[]) => process.stderr.write(`${lines.join("\n")}\n`));

  const byMode = new Map<string, number>();
  for (const row of registry.list()) byMode.set(row.mode, (byMode.get(row.mode) ?? 0) + 1);

  return {
    registry,
    ctx,
    vault,
    redactor,
    ledger: new TokenLedger(),
    principal: `local:${userInfo().username}`,
    policy: createPolicy(opts.fastMode ?? false),
    purchase: { db, registry, ctx, fx, announce, vault },
    summary:
      `${loaded.length} stores (` +
      [...byMode.entries()].map(([mode, n]) => `${n} ${mode}`).join(", ") +
      `)${snapshots ? " [SNAPSHOTS]" : ""}`,
  };
}
