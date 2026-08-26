import { z } from "zod";

/**
 * Money is always an explicit {value, currency} pair. There is no "just a
 * number" anywhere in the contract, because the two places a shopping agent
 * can do real damage are the decimal point and the currency.
 *
 * `value` is in MAJOR units (14.00 = fourteen dollars). Upstream UCP responses
 * use integer MINOR units (1400) -- see fromMinor. Getting this backwards puts
 * $800 leggings on stage, so the conversion lives in exactly one place.
 */
export const MoneySchema = z.object({
  value: z.number(),
  currency: z.string().length(3),
  /** e.g. "each", "per 500g". Present when the retailer states a unit price. */
  unit: z.string().optional(),
});
export type Money = z.infer<typeof MoneySchema>;

/**
 * Currencies whose minor unit is not 1/100. Without this table, JPY 1400 reads
 * as ¥14.00 instead of ¥1400.
 */
const MINOR_UNIT_EXPONENT: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  TWD: 2,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  JOD: 3,
};

export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

/** Convert an upstream integer minor-unit amount into Money. */
export function fromMinor(amount: number, currency: string, unit?: string): Money {
  const exp = minorUnitExponent(currency);
  const money: Money = {
    value: Number((amount / 10 ** exp).toFixed(exp)),
    currency: currency.toUpperCase(),
  };
  if (unit) money.unit = unit;
  return money;
}

/** Convert Money back to integer minor units, for hashing and for upstream calls. */
export function toMinor(money: Money): number {
  return Math.round(money.value * 10 ** minorUnitExponent(money.currency));
}

export function formatMoney(money: Money): string {
  const exp = minorUnitExponent(money.currency);
  return `${money.value.toFixed(exp)} ${money.currency}`;
}

/**
 * A converted figure NEVER travels as a bare number. If we converted it, we say
 * so, with the rate and the date the rate is from (§4). A user comparing a GBP
 * and a USD price deserves to know which one we touched.
 */
export const ConvertedMoneySchema = MoneySchema.extend({
  converted_from: z.string().length(3),
  rate: z.number().positive(),
  as_of: z.string(),
});
export type ConvertedMoney = z.infer<typeof ConvertedMoneySchema>;
