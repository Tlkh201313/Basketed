import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FxTable } from "@basketed/core";

/**
 * Reading the pinned FX table without letting it take the server down.
 *
 * `fixtures/fx.json` is a build-time artefact, so the interesting failure is
 * not a bad rate -- it is the file being absent or truncated in somebody
 * else's checkout, a packaged install, or a working directory that is not the
 * repo root. That used to throw straight out of createRuntime, so a shopper
 * lost search, cart, orders and the panel because a currency table would not
 * parse. Search has nothing to do with this file.
 *
 * The fallback is deliberately the smallest honest table: base USD, one rate.
 * It is NOT a guess at the missing rates -- convertMoney raises
 * UnknownCurrencyError for anything else, so a spend cap in GBP is refused
 * rather than evaluated at parity. Degrading to "cannot price this" is the
 * behaviour we want; degrading to "1:1" would let a cap be bypassed.
 */

export const FALLBACK_FX: FxTable = {
  base: "USD",
  as_of: "unavailable",
  source:
    "FALLBACK -- fixtures/fx.json could not be read. Only USD can be priced; " +
    "any other currency is refused rather than converted on a guessed rate.",
  rates: { USD: 1 },
};

/** True when the parsed value is a usable table rather than merely valid JSON. */
function isFxTable(value: unknown): value is FxTable {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Partial<FxTable>;
  if (typeof t.base !== "string" || !t.base) return false;
  if (typeof t.rates !== "object" || t.rates === null) return false;
  const rates = t.rates as Record<string, unknown>;
  const entries = Object.entries(rates);
  if (entries.length === 0) return false;
  for (const [code, rate] of entries) {
    if (!/^[A-Za-z]{3}$/.test(code)) return false;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return false;
  }
  return typeof rates[t.base] === "number";
}

/**
 * Loads `fixtures/fx.json` under `root`, or returns FALLBACK_FX and says why.
 * Never throws.
 */
export async function loadFx(root: string, log: (msg: string) => void): Promise<FxTable> {
  const path = resolve(root, "fixtures/fx.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    log(
      `no FX table at ${path} (${(err as Error).message}). ` +
        `Prices are still shown as the store quotes them; spend caps can only be ` +
        `evaluated in USD until it is restored.`,
    );
    return FALLBACK_FX;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log(`FX table at ${path} is not valid JSON (${(err as Error).message}); falling back to USD only.`);
    return FALLBACK_FX;
  }

  if (!isFxTable(parsed)) {
    log(`FX table at ${path} is not a usable rate table; falling back to USD only.`);
    return FALLBACK_FX;
  }
  return parsed;
}
