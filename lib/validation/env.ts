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
  // Required from #29 — $29/mo recurring price for Tier 2 per-offer WL upgrades
  STRIPE_WL_TIER2_PRICE_ID: z.string().min(1),
  // Required from #28 in production — distributed rate limiter (Upstash Redis)
  UPSTASH_REDIS_REST_URL:
    process.env.NODE_ENV === "production"
      ? z.string().url()
      : z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN:
    process.env.NODE_ENV === "production"
      ? z.string().min(1)
      : z.string().min(1).optional(),
  // #49 — gates agent/workflow/bundle solution types in vendor onboarding
  SOLUTIONS_NON_SAAS_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  // #41 — AI Gateway provider key vault (envelope encryption)
  // JSON object: { "1": "<base64-32-bytes>", "2": "..." }
  KEY_VAULT_MASTER_KEYS: z.string().min(1),
  // Active master key version (integer string)
  KEY_VAULT_ACTIVE_VERSION: z.string().regex(/^\d+$/).default("1"),
  // Gates the /api/gateway/* routes; false = 404 in production until keys provisioned
  GATEWAY_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  // #43 — Connectors: HMAC-SHA256 key for signing OAuth state params (CSRF protection)
  CONNECTOR_STATE_SECRET: z.string().min(16),
  // #43 — Google OAuth app credentials (for Gmail + Sheets connectors)
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  // #43 — Slack OAuth app credentials
  SLACK_CLIENT_ID: z.string().min(1).optional(),
  SLACK_CLIENT_SECRET: z.string().min(1).optional(),
  // #53 — HMAC-SHA256 key for signing client branding cookies (1h TTL)
  CLIENT_BRANDING_SECRET: z.string().min(16).optional(),
  // #45 — Partner-client erasure grace window (days). Default 30.
  ERASURE_GRACE_DAYS: z.string().optional().default("30").transform(Number),
  // #45 — Retention window for workflow run I/O content (days). Default 90.
  RETENTION_DAYS_WORKFLOW_RUN_IO: z.string().optional().default("90").transform(Number),
  // #45 — Retention window for gateway debug logs (days). Default 90.
  RETENTION_DAYS_GATEWAY_LOGS: z.string().optional().default("90").transform(Number),
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
