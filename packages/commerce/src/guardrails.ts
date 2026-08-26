import { convertMoney, isConverted, UnknownCurrencyError, type FxTable, type Money } from "@basketed/core";
import type { Db } from "./db.js";
import type { CartMandate } from "./mandate.js";

/**
 * The Intent Mandate (§6, §10): the user's standing rules of engagement.
 *
 * Every one of these is evaluated at `purchase_confirm`, NOT at
 * `cart_prepare`. Checking at prepare time would mean a cart that passed the
 * caps an hour ago can still execute after the daily total has moved -- the
 * check has to happen at the moment money would move.
 */
export interface Guardrails {
  homeCurrency: string;
  /** Per-order ceiling in the home currency. */
  perOrderCap: number;
  /** Rolling 24-hour ceiling in the home currency. */
  dailyCap: number;
  /** Empty means "any registered store". Populated means exactly these. */
  allowedStores: string[];
  /** Empty means no address has been allowlisted yet, which blocks addressed orders. */
  allowedAddresses: string[];
}

export const DEFAULT_GUARDRAILS: Guardrails = {
  homeCurrency: "USD",
  perOrderCap: 250,
  dailyCap: 500,
  allowedStores: [],
  allowedAddresses: [],
};

export interface GuardrailVerdict {
  allowed: boolean;
  /** Plain-language reason, safe to show an agent. Never names a secret. */
  reason?: string;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  /** The order total in home currency, labelled if it was converted. */
  normalisedTotal: Money;
}

export function loadGuardrails(db: Db): Guardrails {
  const rows = db.prepare("SELECT k, v FROM settings").all() as Array<{ k: string; v: string }>;
  const map = new Map(rows.map((r) => [r.k, r.v]));
  const num = (k: string, fallback: number) => {
    const raw = map.get(k);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const list = (k: string) => {
    const raw = map.get(k);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  };
  return {
    homeCurrency: map.get("home_currency") ?? DEFAULT_GUARDRAILS.homeCurrency,
    perOrderCap: num("per_order_cap", DEFAULT_GUARDRAILS.perOrderCap),
    dailyCap: num("daily_cap", DEFAULT_GUARDRAILS.dailyCap),
    allowedStores: list("allowed_stores"),
    allowedAddresses: list("allowed_addresses"),
  };
}

export function saveGuardrails(db: Db, g: Partial<Guardrails>): void {
  const put = db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
  if (g.homeCurrency) put.run("home_currency", g.homeCurrency.toUpperCase());
  if (g.perOrderCap !== undefined) put.run("per_order_cap", String(g.perOrderCap));
  if (g.dailyCap !== undefined) put.run("daily_cap", String(g.dailyCap));
  if (g.allowedStores) put.run("allowed_stores", JSON.stringify(g.allowedStores));
  if (g.allowedAddresses) put.run("allowed_addresses", JSON.stringify(g.allowedAddresses));
}

/** Total already spent in the rolling window, in home currency. */
export function spentInWindow(db: Db, windowMs = 24 * 60 * 60 * 1000, now = Date.now()): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount_home), 0) AS total FROM spend WHERE at > ?")
    .get(now - windowMs) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

export function recordSpend(db: Db, approvalId: string, amountHome: number, homeCurrency: string, now = Date.now()): void {
  db.prepare("INSERT INTO spend (approval_id, amount_home, home_currency, at) VALUES (?, ?, ?, ?)").run(
    approvalId,
    amountHome,
    homeCurrency,
    now,
  );
}

export function evaluateGuardrails(
  db: Db,
  mandate: CartMandate,
  guardrails: Guardrails,
  fx: FxTable,
  now = Date.now(),
): GuardrailVerdict {
  const checks: GuardrailVerdict["checks"] = [];

  let normalised: Money;
  try {
    normalised = convertMoney(mandate.total, guardrails.homeCurrency, fx);
  } catch (err) {
    if (err instanceof UnknownCurrencyError) {
      return {
        allowed: false,
        reason: err.message,
        checks: [{ name: "currency", passed: false, detail: err.message }],
        normalisedTotal: mandate.total,
      };
    }
    throw err;
  }

  const label = isConverted(normalised)
    ? `${normalised.value.toFixed(2)} ${normalised.currency} (converted from ${normalised.converted_from} at ${normalised.rate}, as of ${normalised.as_of})`
    : `${normalised.value.toFixed(2)} ${normalised.currency}`;

  const perOrder = normalised.value <= guardrails.perOrderCap;
  checks.push({
    name: "per_order_cap",
    passed: perOrder,
    detail: `${label} against a ${guardrails.perOrderCap.toFixed(2)} ${guardrails.homeCurrency} per-order cap`,
  });

  const already = spentInWindow(db, 24 * 60 * 60 * 1000, now);
  const daily = already + normalised.value <= guardrails.dailyCap;
  checks.push({
    name: "daily_cap",
    passed: daily,
    detail: `${(already + normalised.value).toFixed(2)} ${guardrails.homeCurrency} in 24h against a ${guardrails.dailyCap.toFixed(2)} cap`,
  });

  const storeOk = guardrails.allowedStores.length === 0 || guardrails.allowedStores.includes(mandate.storeId);
  checks.push({
    name: "store_allowlist",
    passed: storeOk,
    detail: guardrails.allowedStores.length ? `${mandate.storeId} against ${guardrails.allowedStores.length} allowed store(s)` : "no store allowlist set",
  });

  // An address is only checked when the cart actually carries one. There is no
  // MCP tool that can set an address in the first place -- removing the tool
  // removed the whole class of attack -- so this catches a panel-set address
  // that was later removed from the allowlist.
  const addressOk = !mandate.addressId || guardrails.allowedAddresses.includes(mandate.addressId);
  checks.push({
    name: "address_allowlist",
    passed: addressOk,
    detail: mandate.addressId ? `address ${mandate.addressId}` : "no delivery address on this cart",
  });

  const failed = checks.find((c) => !c.passed);
  return {
    allowed: !failed,
    ...(failed ? { reason: `Guardrail "${failed.name}" refused this purchase: ${failed.detail}.` } : {}),
    checks,
    normalisedTotal: normalised,
  };
}
