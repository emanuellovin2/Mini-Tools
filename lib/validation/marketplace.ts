import { z } from "zod";
import type { MarketplaceSort } from "@/lib/services/apps";

export const SORT_OPTIONS: { value: MarketplaceSort; label: string }[] = [
  { value: "trending", label: "Trending" },
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: Low → High" },
  { value: "price_desc", label: "Price: High → Low" },
  { value: "rating", label: "Top Rated" },
];

const sortEnum = z.enum([
  "trending",
  "newest",
  "price_asc",
  "price_desc",
  "rating",
]);

export const marketplaceParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  category: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  sort: sortEnum.default("trending"),
  priceMin: z.coerce.number().int().min(0).optional(),
  priceMax: z.coerce.number().int().min(0).optional(),
  ratingMin: z.coerce.number().min(1).max(5).optional(),
  hasAffiliate: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  hasTrial: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

export type MarketplaceParams = z.infer<typeof marketplaceParamsSchema>;

export function parseMarketplaceParams(
  raw: Record<string, string | string[] | undefined>
): MarketplaceParams {
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    flat[k] = Array.isArray(v) ? v[0] : v;
  }
  const result = marketplaceParamsSchema.safeParse(flat);
  return result.success ? result.data : { page: 1, sort: "trending" };
}

export function buildMarketplaceHref(
  base: MarketplaceParams,
  overrides: Partial<MarketplaceParams & { page: number }>
): string {
  const merged = { ...base, ...overrides };
  const p = new URLSearchParams();
  if (merged.search) p.set("search", merged.search);
  if (merged.category) p.set("category", merged.category);
  if (merged.sort && merged.sort !== "trending") p.set("sort", merged.sort);
  if (merged.page && merged.page > 1) p.set("page", String(merged.page));
  if (merged.priceMin != null) p.set("priceMin", String(merged.priceMin));
  if (merged.priceMax != null) p.set("priceMax", String(merged.priceMax));
  if (merged.ratingMin != null) p.set("ratingMin", String(merged.ratingMin));
  if (merged.hasAffiliate != null)
    p.set("hasAffiliate", String(merged.hasAffiliate));
  if (merged.hasTrial != null) p.set("hasTrial", String(merged.hasTrial));
  const qs = p.toString();
  return `/marketplace${qs ? `?${qs}` : ""}`;
}
