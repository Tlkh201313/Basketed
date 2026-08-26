import { z } from "zod";
import { CapabilityTierSchema, SourcingModeSchema } from "./product.js";
import { CATEGORIES } from "./attrs.js";

export const ProviderSchema = z.enum(["serpapi", "firecrawl", "apify", "oxylabs"]);
export const AuthKindSchema = z.enum(["none", "oauth2", "apikey", "simulated"]);

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
  auth: AuthKindSchema,
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
