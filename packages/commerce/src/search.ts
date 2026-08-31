import type { Product, SearchQuery, SearchResult } from "@basketed/core";
import { buildMeta, trimResults, type TrimOptions } from "@basketed/core";
import type { AdapterCtx, StoreAdapter, StoreRegistry } from "@basketed/adapters";

export interface SearchOptions extends TrimOptions {
  stores?: string[];
  /** Per-store timeout. One slow store must not hold the whole response. */
  timeoutMs?: number;
}

export interface SearchDiagnostics {
  queried: string[];
  failed: Array<{ store: string; reason: string }>;
  baselineBytes: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * Fan out across every searchable store and merge the results.
 *
 * Two deliberate behaviours:
 *
 *  - A store that fails does not fail the search. Shopping across ten
 *    retailers where one is down should return nine sets of results and say
 *    which one was missing, not return an error.
 *  - Results are NOT re-ranked across stores by relevance, because relevance
 *    scores from different retailers are not comparable. They are ordered by
 *    price within the merged set, which is a comparison the user actually
 *    asked for.
 */
export async function searchAll(
  registry: StoreRegistry,
  query: SearchQuery,
  ctx: AdapterCtx,
  opts: SearchOptions = {},
): Promise<{ result: SearchResult; diagnostics: SearchDiagnostics }> {
  const adapters: StoreAdapter[] = registry.searchable(opts.stores);
  const timeoutMs = opts.timeoutMs ?? 12_000;

  const settled = await Promise.allSettled(
    adapters.map(async (a) => ({
      adapter: a,
      products: await withTimeout(a.search(query, ctx), timeoutMs, a.manifest.id),
    })),
  );

  const products: Product[] = [];
  const queried: string[] = [];
  const failed: SearchDiagnostics["failed"] = [];
  let baselineBytes = 0;

  settled.forEach((s, i) => {
    const adapter = adapters[i]!;
    if (s.status === "fulfilled") {
      queried.push(adapter.manifest.id);
      products.push(...s.value.products);
      // The honest baseline: bytes we actually received. Simulated adapters
      // report nothing, so they cannot inflate the savings figure.
      baselineBytes += adapter.lastRawBytes ?? 0;
    } else {
      failed.push({ store: adapter.manifest.id, reason: String(s.reason?.message ?? s.reason).slice(0, 200) });
      ctx.log(`store ${adapter.manifest.id} failed: ${String(s.reason?.message ?? s.reason).slice(0, 160)}`);
    }
  });

  products.sort((a, b) => a.price.value - b.price.value);

  const outcome = trimResults(products, opts);
  const meta = buildMeta({ storesQueried: queried, baselineBytes, outcome });

  return {
    result: { results: outcome.results as Product[], _meta: meta },
    diagnostics: { queried, failed, baselineBytes },
  };
}
