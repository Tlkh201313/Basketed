import type { ConvertedMoney, Money } from "./schema/money.js";

/**
 * Currency conversion for spend caps and cross-store comparison (§4).
 *
 * Two rules, both about honesty rather than arithmetic:
 *
 *  - The table is PINNED with an `as_of` date and shipped as a fixture. A live
 *    feed would make the demo depend on a third party being up, and a cap that
 *    silently changes because a rate moved is worse than one that is a day old.
 *  - Every converted figure carries `converted_from`, `rate` and `as_of`. We
 *    never show a converted number without saying it was converted -- a "£40
 *    cap" that quietly became "$50" is how a guardrail stops meaning anything.
 *
 * An unknown currency is a hard failure, not a 1:1 guess. Treating an unknown
 * rate as parity would let a cap be bypassed by quoting in a currency the
 * table has never heard of.
 */

export interface FxTable {
  base: string;
  as_of: string;
  source: string;
  rates: Record<string, number>;
}

export class UnknownCurrencyError extends Error {
  constructor(readonly currency: string) {
    super(
      `No pinned FX rate for ${currency}. Spend caps cannot be evaluated against it, ` +
        `so the purchase is refused rather than approved on a guessed rate.`,
    );
    this.name = "UnknownCurrencyError";
  }
}

export function convertMoney(amount: Money, to: string, fx: FxTable): ConvertedMoney | Money {
  const from = amount.currency.toUpperCase();
  const target = to.toUpperCase();
  if (from === target) return amount;

  const fromRate = fx.rates[from];
  const toRate = fx.rates[target];
  if (fromRate === undefined) throw new UnknownCurrencyError(from);
  if (toRate === undefined) throw new UnknownCurrencyError(target);

  // Both rates are quoted against the table's base, so cross-convert through it.
  const rate = toRate / fromRate;
  return {
    value: Number((amount.value * rate).toFixed(2)),
    currency: target,
    converted_from: from,
    rate: Number(rate.toFixed(6)),
    as_of: fx.as_of,
    ...(amount.unit ? { unit: amount.unit } : {}),
  };
}

/** True when the figure came out of a conversion and must be labelled as one. */
export function isConverted(money: Money | ConvertedMoney): money is ConvertedMoney {
  return "converted_from" in money;
}
