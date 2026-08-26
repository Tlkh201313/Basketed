import { z } from "zod";

/**
 * Category-aware attributes (§3.1). A discriminated union on `cat`, resolved
 * through a registry so adding a category is data rather than code.
 *
 * Why not one flat bag of optional fields: an agent comparing sofas wants
 * dimensions, an agent comparing coffee wants unit price. A flat schema would
 * ship every field to every caller, which is exactly the token waste this
 * project exists to remove.
 */

const base = { brand: z.string().optional() };

export const GroceryAttrs = z.object({
  cat: z.literal("grocery"),
  ...base,
  size: z.string().optional(),
  unit_price: z.string().optional(),
  per_unit: z.string().optional(),
  diet: z.array(z.string()).optional(),
  promo: z.string().optional(),
});

export const FurnitureAttrs = z.object({
  cat: z.literal("furniture"),
  ...base,
  dims: z
    .object({ w: z.number(), d: z.number(), h: z.number(), unit: z.string() })
    .optional(),
  material: z.string().optional(),
  colour: z.string().optional(),
  assembly: z.boolean().optional(),
  room: z.string().optional(),
});

export const ElectronicsAttrs = z.object({
  cat: z.literal("electronics"),
  ...base,
  specs: z.record(z.string(), z.string()).optional(),
  warranty_months: z.number().int().optional(),
  model: z.string().optional(),
});

export const ApparelAttrs = z.object({
  cat: z.literal("apparel"),
  ...base,
  size: z.string().optional(),
  colour: z.string().optional(),
  material: z.string().optional(),
  fit: z.string().optional(),
});

export const GeneralAttrs = z.object({
  cat: z.literal("general"),
  ...base,
  condition: z.string().optional(),
  seller: z.string().optional(),
});

export const AttrsSchema = z.discriminatedUnion("cat", [
  GroceryAttrs,
  FurnitureAttrs,
  ElectronicsAttrs,
  ApparelAttrs,
  GeneralAttrs,
]);
export type Attrs = z.infer<typeof AttrsSchema>;

export const CATEGORIES = ["grocery", "furniture", "electronics", "apparel", "general"] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Best-effort category inference from a store's own category strings and the
 * product title. Deliberately conservative: unknown falls back to "general"
 * rather than guessing, because a wrong `cat` silently drops the fields that
 * category cares about.
 */
const HINTS: Array<[Category, RegExp]> = [
  ["grocery", /\b(coffee|tea|food|snack|grocer|drink|beverage|chocolate|organic|beans?)\b/i],
  ["apparel", /\b(shirt|tee|legging|short|dress|jacket|hoodie|sock|apparel|clothing|wear|pant|denim)\b/i],
  ["electronics", /\b(phone|laptop|headphone|camera|charger|electronic|speaker|monitor|tablet)\b/i],
  ["furniture", /\b(sofa|chair|table|desk|shelf|bed|furniture|rug|mattress)\b/i],
];

export function inferCategory(...signals: Array<string | undefined | null>): Category {
  const hay = signals.filter(Boolean).join(" ");
  for (const [cat, re] of HINTS) if (re.test(hay)) return cat;
  return "general";
}
