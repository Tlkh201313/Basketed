/**
 * Per-call policy for the MCP surface — where `--fast-mode` lives.
 *
 * Fast mode skips per-call confirmation for READ-ONLY tools only. The promise
 * we make about it is stronger than "the purchase path ignores the flag": the
 * flag is not reachable from the purchase path at all.
 *
 * `@basketed/commerce` -- which owns `cart_prepare`, the approval state
 * machine, the guardrails and `purchase_confirm` -- does not depend on
 * `@basketed/mcp` in either direction of the workspace graph, and
 * `packages/mcp/src/purchase.test.ts` asserts that no module reachable from
 * `commerce/purchase.ts` ever imports this file. A refactor that wires them
 * together fails CI instead of quietly re-opening the hole.
 *
 * That is the difference between a README claim and a proof.
 */

export type ToolPolicy = "allow" | "ask" | "locked";

/**
 * Tools that can never be promoted to ALLOW, in any mode, by any flag.
 *
 * This list is advisory belt-and-braces for the panel UI. The enforcement is
 * in commerce: `purchase_confirm` refuses without a human approval event on
 * record regardless of what any policy here says.
 */
export const NEVER_ALLOW = [
  // Basket mode writes to an account the person connected. It cannot charge
  // it, but "skip confirmation" was promised for read-only tools only.
  "basket_add_to_cart",
  "basket_cart_prepare",
  "basket_purchase_confirm",
  "basket_cancel_order",
] as const;

export interface Policy {
  /** Skips per-call confirmation for read-only tools. Never anything else. */
  fastMode: boolean;
}

export function createPolicy(fastMode = false): Policy {
  return { fastMode };
}

/**
 * Whether a read-only tool may skip confirmation.
 *
 * Deliberately takes only read-only tools: a money-adjacent name returns
 * `false` no matter what, so a caller that forgets to check `NEVER_ALLOW`
 * still cannot use this to wave a purchase through.
 */
export function mayAutoConfirm(policy: Policy, toolName: string): boolean {
  if ((NEVER_ALLOW as readonly string[]).includes(toolName)) return false;
  return policy.fastMode;
}
