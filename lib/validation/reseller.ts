import { z } from "zod";

export const slugSchema = z.object({
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(40, "Slug must be at most 40 characters")
    .regex(/^[a-z0-9-]+$/, "Slug must contain only lowercase letters, numbers, and hyphens")
    .refine((s) => !s.startsWith("-") && !s.endsWith("-"), "Slug cannot start or end with a hyphen"),
});

export const createOfferSchema = z.object({
  app_id: z.string().uuid("Invalid app ID"),
  slug: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9-]+$/)
    .refine((s) => !s.startsWith("-") && !s.endsWith("-")),
  sell_price_dollars: z
    .number()
    .positive("Price must be positive")
    .finite(),
});

export type CreateOfferInput = z.infer<typeof createOfferSchema>;
