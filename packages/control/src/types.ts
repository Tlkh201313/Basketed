import type { PurchaseDeps } from "@basketed/commerce";
import type { StoreRegistry } from "@basketed/adapters";

/**
 * What the panel needs, declared here rather than imported from `@basketed/mcp`.
 *
 * `Runtime` satisfies this structurally, so the CLI passes one straight in --
 * but the control package does not depend on the MCP package to say so. That
 * keeps the two surfaces genuinely independent: the panel is a separate
 * channel the agent cannot reach, and a type dependency pointing the wrong way
 * would be the first step towards that stopping being true.
 */
export interface ControlDeps {
  purchase: PurchaseDeps;
  registry: StoreRegistry;
  /** Derived from the local session. The panel never accepts one from a request. */
  principal: string;
  policy: { fastMode: boolean };
  ledger: { report(): unknown };
  summary: string;
  version: string;
  /** How many times the redaction net has fired. A non-zero count is a bug. */
  redactionAlarms: () => number;
}
