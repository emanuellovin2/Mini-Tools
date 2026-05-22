import { z } from "zod";

export const appSubmitSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(100),
    description: z.string().max(1000).optional(),
    category: z.string().min(1).max(50).optional(),
    price_dollars: z
      .coerce
      .number()
      .positive("Price must be positive")
      .max(99999),
    min_price_dollars: z.preprocess(
      (v) => (v === "" || v == null ? undefined : v),
      z.coerce.number().min(0).max(99999).optional()
    ),
    auth_url: z
      .string()
      .url("Must be a valid URL")
      .refine((u) => u.startsWith("https://"), "Must use HTTPS"),
  })
  .refine(
    (d) =>
      d.min_price_dollars === undefined ||
      d.min_price_dollars <= d.price_dollars,
    {
      message: "Resell floor must not exceed the app price",
      path: ["min_price_dollars"],
    }
  );

export type AppSubmitData = z.infer<typeof appSubmitSchema>;

export const displayNameSchema = z.object({
  display_name: z
    .string()
    .min(1, "Display name is required")
    .max(100, "Display name too long"),
});
