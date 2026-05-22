import { z } from "zod";

export const marketplaceParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  category: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
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
  return result.success ? result.data : { page: 1 };
}
