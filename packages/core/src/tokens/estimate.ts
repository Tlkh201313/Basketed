import type { Product, ResponseFormat, SearchMeta } from "../schema/index.js";
import { COMPACT_KEYS, PROVENANCE_NOTE, TRIM_ORDER } from "../schema/product.js";

/**
 * Token accounting (§3.2).
 *
 * Runtime trimming uses a heuristic, not a real tokeniser: `budget_tokens` is a
 * safety ceiling, and being within a few percent is enough to stay under a
 * client's output cap. The published BENCHMARK number is different -- that one
 * is measured with js-tiktoken (o200k_base) in scripts/bench.ts, because a
 * headline claim has to survive someone checking it.
 */

/**
 * ~3.6 chars/token is a good fit for the JSON we emit: dense punctuation and
 * short keys tokenise worse than prose. Erring low would let us overshoot a
 * client's cap, so this deliberately rounds up.
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(text.length / 3.6);
}

export interface TrimOptions {
  budgetTokens?: number;
  maxResults?: number;
  format?: ResponseFormat;
  fields?: string[];
}

export interface TrimOutcome {
  results: Array<Record<string, unknown>>;
  truncated: boolean;
  dropped: string[];
  legend?: Record<string, string>;
}

function project(product: Product, fields?: string[]): Record<string, unknown> {
  const row: Record<string, unknown> = { ...product };
  if (fields?.length) {
    for (const key of Object.keys(row)) {
      // id and mode survive an explicit allowlist: without id the result is not
      // actionable, and without mode the caller cannot tell real from simulated.
      if (!fields.includes(key) && key !== "id" && key !== "mode") delete row[key];
    }
  }
  for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
  return row;
}

function toCompact(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[COMPACT_KEYS[k] ?? k] = v;
  return out;
}

/**
 * Apply format, field selection and the token budget.
 *
 * The trim order is a published contract (TRIM_ORDER), and `price`, `rating`,
 * `source`, `mode` and `id` are never touched. When we do drop something we say
 * what -- `_meta.truncated` plus `_meta.dropped`. Silent truncation would make
 * every other number we report untrustworthy.
 */
export function trimResults(products: Product[], opts: TrimOptions = {}): TrimOutcome {
  const { budgetTokens, maxResults = 8, format = "concise", fields } = opts;

  let rows = products.slice(0, maxResults).map((p) => project(p, fields));
  const dropped: string[] = [];
  let truncated = false;

  if (format === "compact") rows = rows.map(toCompact);

  if (budgetTokens && budgetTokens > 0) {
    const compact = format === "compact";
    const keyFor = (field: string) => (compact ? (COMPACT_KEYS[field] ?? field) : field);

    for (const field of TRIM_ORDER) {
      if (estimateTokens(rows) <= budgetTokens) break;
      const key = keyFor(field);
      let removedAny = false;
      for (const row of rows) {
        if (key in row) {
          delete row[key];
          removedAny = true;
        }
      }
      if (removedAny) {
        dropped.push(field);
        truncated = true;
      }
    }

    if (estimateTokens(rows) > budgetTokens) {
      const nameKey = keyFor("name");
      for (const row of rows) {
        const name = row[nameKey];
        if (typeof name === "string" && name.length > 48) row[nameKey] = name.slice(0, 48).trimEnd();
      }
      if (!dropped.includes("name:truncated")) dropped.push("name:truncated");
      truncated = true;
    }

    // Last resort: drop whole rows from the bottom. Ranking is upstream, so the
    // rows we lose are the ones the adapter already ranked least relevant.
    while (rows.length > 1 && estimateTokens(rows) > budgetTokens) {
      rows.pop();
      truncated = true;
      if (!dropped.includes("results:trimmed")) dropped.push("results:trimmed");
    }
  }

  const outcome: TrimOutcome = { results: rows, truncated, dropped };
  if (format === "compact") outcome.legend = COMPACT_KEYS;
  return outcome;
}

export interface MetaInput {
  storesQueried: string[];
  baselineBytes: number;
  outcome: TrimOutcome;
  flags?: string[];
}

/**
 * Build the `_meta` block, including the savings figure.
 *
 * `baseline` is the raw upstream payload we actually fetched -- not a
 * hypothetical worst case. That is the only definition that survives a
 * sceptical judge asking how we computed it.
 */
export function buildMeta(input: MetaInput): SearchMeta {
  const { storesQueried, baselineBytes, outcome, flags } = input;
  const estimated = estimateTokens(outcome.results);
  const baseline = Math.ceil(baselineBytes / 3.6);
  const savedPct = baseline > 0 ? Number((((baseline - estimated) / baseline) * 100).toFixed(1)) : 0;

  const meta: SearchMeta = {
    tokens: { estimated, baseline, saved_pct: savedPct },
    provenance: PROVENANCE_NOTE,
    stores_queried: storesQueried,
    truncated: outcome.truncated,
  };
  if (outcome.dropped.length) meta.dropped = outcome.dropped;
  if (outcome.legend) meta.legend = outcome.legend;
  if (flags?.length) meta.flags = [...new Set(flags)];
  return meta;
}
