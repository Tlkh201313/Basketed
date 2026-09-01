import { z } from "zod";
import { CapabilityTierSchema, SourcingModeSchema } from "./product.js";
import { CATEGORIES } from "./attrs.js";

export const ProviderSchema = z.enum(["serpapi", "firecrawl", "apify", "oxylabs"]);

/**
 * Where "Connect" sends a human, and what to read back afterwards.
 *
 * This lived in a hand-maintained table in the control panel until S21, keyed
 * by store id. That table was the only place that knew Tesco has an account
 * and Etsy does not, which meant the panel could say one thing while the
 * adapter did another and nothing would catch it. The adapter is the only
 * thing that actually knows, so the adapter is where it is declared now, and
 * the panel is a projection of it.
 */
export const AccountLoginSchema = z.object({
  /** Where the tab lands first: a page that reveals whether you are signed in. */
  url: z.string(),
  /**
   * Where to send someone who turns out NOT to be signed in. Landing a
   * signed-out shopper on a homepage and leaving them to find the account
   * menu is a worse flow than opening the login page for them.
   */
  loginUrl: z.string(),
  /** Hostnames whose cookies belong to this account. Also the extension's host permissions. */
  domains: z.array(z.string()).min(1),
  /**
   * Cookie-name prefixes that only a signed-in session has. Polled so the
   * panel can say "you are in" by itself rather than asking a human to
   * confirm a login they just performed.
   *
   * Best-effort signatures, not a contract: no retailer documents its cookies
   * and any of them may rename one without notice. A miss stays recoverable --
   * the capture route never consults this list.
   */
  authCookies: z.array(z.string()),
  /**
   * Headers to lift off the store's own API call, when the credential is not
   * in the cookie jar at all.
   *
   * Every header named here is REQUIRED. A capture missing one is refused
   * rather than sealed, because half a session succeeds here and fails later,
   * somewhere with much less context.
   */
  capture: z.object({ match: z.string(), headers: z.array(z.string()).min(1) }).optional(),
});
export type AccountLogin = z.infer<typeof AccountLoginSchema>;

/**
 * Whether this store has an account at all, and what a session buys you.
 *
 * Three kinds, because there are exactly three honest answers:
 *
 *   - `none` -- everything this adapter does, it does signed out. Every scrape
 *     store and every anonymous UCP endpoint. Offering "Connect" here would
 *     invent an account that does not exist, and sealing cookies nothing reads
 *     would show a "connected" badge that means nothing.
 *   - `demo` -- a simulated store. There is a fake account handle so the
 *     purchase rail can be exercised, and it is never a real credential.
 *   - `session` -- some named tiers need a signed-in session. `uses` says
 *     which ones, and the registry refuses a store that names a tier it does
 *     not implement, so this can never claim more reach than the adapter has.
 *
 * `refresh: "browser"` is the only renewal there is: the human signs in again
 * on the retailer's own page. No retailer here publishes a consumer OAuth
 * flow, and none of them will hand out a refresh token to a shopping agent.
 */
export const StoreAccountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("demo") }),
  z.object({
    kind: z.literal("session"),
    uses: z.array(CapabilityTierSchema).min(1),
    login: AccountLoginSchema,
    refresh: z.literal("browser"),
  }),
]);
export type StoreAccount = z.infer<typeof StoreAccountSchema>;

/**
 * What a store declares about itself (§4).
 *
 * `mode` and `capabilities` are the two honesty constraints in the whole
 * project: mode says where the data came from, capabilities says what the
 * adapter can genuinely do. The conformance suite fails any adapter that
 * claims a tier it does not implement, which is what stops "capabilities" from
 * drifting into marketing.
 */
export const StoreManifestSchema = z.object({
  /** Namespaced: "shp:gymshark" | "prv:tesco" | "sim:taobao". The prefix is the mode. */
  id: z.string(),
  name: z.string(),
  country: z.string().length(2),
  currency: z.string().length(3),
  language: z.string(),
  categories: z.array(z.enum(CATEGORIES)),
  mode: SourcingModeSchema,
  provider: ProviderSchema.optional(),
  /** Whether there is an account here, and what a session unlocks (S21). */
  account: StoreAccountSchema,
  capabilities: z.array(CapabilityTierSchema),
  /** Native endpoint, when the adapter talks to one. */
  endpoint: z.string().optional(),
  domain: z.string().optional(),
});
export type StoreManifest = z.infer<typeof StoreManifestSchema>;

export const StoreStatusSchema = z.enum(["ready", "needs_key", "needs_auth", "expired"]);
export type StoreStatus = z.infer<typeof StoreStatusSchema>;

/** What list_stores returns per row. Never includes credentials of any kind. */
export const StoreRowSchema = StoreManifestSchema.extend({
  status: StoreStatusSchema,
});
export type StoreRow = z.infer<typeof StoreRowSchema>;

export const SearchQuerySchema = z.object({
  query: z.string(),
  maxResults: z.number().int().positive().max(50).optional(),
  priceMax: z.number().positive().optional(),
  country: z.string().length(2).optional(),
  currency: z.string().length(3).optional(),
  sort: z.enum(["relevance", "price_asc", "price_desc", "rating"]).optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
