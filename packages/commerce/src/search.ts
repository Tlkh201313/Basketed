import type { Product, SearchQuery, SearchResult } from "@basketed/core";
import { buildMeta, trimResults, type TrimOptions } from "@basketed/core";
import type { AdapterCtx, StoreAdapter, StoreRegistry } from "@basketed/adapters";
import { withRetry, withTimeout } from "./retry.js";

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

const SEARCH_CACHE = new Map<string, { products: Product[]; baseline: number; at: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(storeId: string, q: SearchQuery): string {
  return `${storeId}|${q.query}|${q.maxResults ?? 8}|${q.priceMax ?? ""}`;
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
    adapters.map(async (a) => {
      const key = cacheKey(a.manifest.id, query);
      const cached = SEARCH_CACHE.get(key);
      const useCache = cached && Date.now() - cached.at < CACHE_TTL_MS;
      try {
        const products = await withRetry(() => withTimeout(a.search(query, ctx), timeoutMs, a.manifest.id));
        const baseline = a.lastRawBytes ?? 0;
        SEARCH_CACHE.set(key, { products, baseline, at: Date.now() });
        return { adapter: a, products, baseline };
      } catch (e) {
        if (useCache) {
          ctx.log(`store ${a.manifest.id} failed live, serving cached ${cached!.products.length} results`);
          // restore cached baseline so token report stays honest (cached bytes, not 0)
          (a as { lastRawBytes?: number }).lastRawBytes = cached!.baseline;
          return { adapter: a, products: cached!.products, baseline: cached!.baseline, cached: true as const };
        }
        throw e;
      }
    }),
  );

  const products: Product[] = [];
  const queried: string[] = [];
  const failed: SearchDiagnostics["failed"] = [];
  let baselineBytes = 0;

  settled.forEach((s, i) => {
    const adapter = adapters[i]!;
    if (s.status === "fulfilled") {
      const isCached = (s.value as { cached?: boolean }).cached === true;
      queried.push(adapter.manifest.id);
      products.push(...s.value.products);
      // Honest baseline: use cached baseline when serving from cache, else live bytes
      baselineBytes += (s.value as { baseline?: number }).baseline ?? adapter.lastRawBytes ?? 0;
      if (isCached) {
        // still count as queried, not failed, but note in log
      }
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
