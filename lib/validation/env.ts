import { z } from "zod";

const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  JWT_KEY_ID: z.string().min(1),
  CHURN_ALERT_THRESHOLD_BPS: z
    .string()
    .optional()
    .default("2000")
    .transform(Number),
  // Optional — defaults to 30. Set to 0 to disable trials.
  RESELLER_TRIAL_DAYS: z
    .string()
    .optional()
    .default("30")
    .transform(Number),
  // Required from #12 — transactional email + admin alerts
  RESEND_API_KEY: z.string().min(1),
  ADMIN_EMAIL: z.string().email(),
  // Optional — defaults to noreply@platform.local
  EMAIL_FROM: z.string().email().optional(),
  // Required from #5
  STRIPE_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1),
  // Required from #6 — use `stripe listen --print-secret` in dev
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  // Required from #14 — Stripe Price id for the reseller's $19/mo platform subscription
  STRIPE_RESELLER_PLAN_PRICE_ID: z.string().min(1),
  // Required from #28 in production — distributed rate limiter (Upstash Redis)
  UPSTASH_REDIS_REST_URL:
    process.env.NODE_ENV === "production"
      ? z.string().url()
      : z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN:
    process.env.NODE_ENV === "production"
      ? z.string().min(1)
      : z.string().min(1).optional(),
});

export type Env = z.infer<typeof serverEnvSchema>;

/**
 * Call once at app boot (e.g. in instrumentation.ts or the root layout).
 * Throws on missing/malformed required vars; warns if RESEND_API_KEY is absent.
 */
export function validateEnv(): Env {
  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Invalid environment variables:");
    console.error(result.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration — server cannot start");
  }
  return result.data;
}
