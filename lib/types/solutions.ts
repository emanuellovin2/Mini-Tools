import { z } from "zod";

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

export const SolutionTypeSchema = z.enum(["saas", "agent", "workflow", "bundle"]);

export const ProductKindSchema = z.enum(["hosted", "gateway", "workflow_template"]);
export type ProductKind = z.infer<typeof ProductKindSchema>;
export type SolutionType = z.infer<typeof SolutionTypeSchema>;

export const SolutionStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "deleted",
]);
export type SolutionStatus = z.infer<typeof SolutionStatusSchema>;

// Semver x.y.z — only stable releases, no pre-release tags
export const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "version must be x.y.z semver");

// ---------------------------------------------------------------------------
// Shared base schema (columns all solution types share)
// ---------------------------------------------------------------------------

export const SolutionBaseSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  vendor_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  category: z.string().nullable(),
  price_cents: z.number().int().nonnegative(),
  min_price_cents: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).default("usd"),
  auth_url: z.string().url().nullable(),
  logo_url: z.string().url().nullable(),
  screenshot_urls: z.array(z.string().url()).default([]),
  status: SolutionStatusSchema,
  stripe_product_id: z.string().nullable(),
  stripe_price_id: z.string().nullable(),
  affiliate_commission_bps: z.number().int().min(2000).max(8000).nullable(),
  rating_avg: z.number().min(0).max(5).default(0),
  rating_count: z.number().int().nonnegative().default(0),
  featured_until: z.string().datetime().nullable(),
  has_free_trial: z.boolean().default(false),
  first_verified_at: z.string().datetime().nullable(),
  // Wave 9 fields
  solution_version: SemverSchema.default("1.0.0"),
  runtime_config: z.record(z.string(), z.unknown()).nullable(),
  template_of_id: z.string().uuid().nullable(),
  is_template: z.boolean().default(false),
  tenant_shard_id: z.number().int().min(0).max(32767).default(0),
  // #44 metered product fields
  product_kind: ProductKindSchema.default("hosted"),
  meter_id: z.string().uuid().nullable().default(null),
  vendor_unit_price_cents: z.number().int().nonnegative().nullable().default(null),
  min_unit_price_cents: z.number().int().nonnegative().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Type-specific runtime_config schemas
// ---------------------------------------------------------------------------

export const SaasRuntimeConfigSchema = z
  .object({
    webhook_url: z.string().url().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .nullable();

export const AgentRuntimeConfigSchema = z.object({
  model: z.string().min(1),
  provider: z.enum(["openai", "anthropic", "google", "custom"]),
  system_prompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const WorkflowRuntimeConfigSchema = z.object({
  trigger: z.enum(["manual", "schedule", "webhook"]),
  schedule_cron: z.string().optional(),
  steps: z.array(z.string()).optional(),
  timeout_seconds: z.number().int().positive().optional(),
});

export const BundleRuntimeConfigSchema = z.object({
  item_solution_ids: z.array(z.string().uuid()).min(1),
  discount_bps: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Discriminated union — one type per solution_type value
// ---------------------------------------------------------------------------

export const SolutionSaasSchema = SolutionBaseSchema.extend({
  solution_type: z.literal("saas"),
  runtime_config: SaasRuntimeConfigSchema,
});

export const SolutionAgentSchema = SolutionBaseSchema.extend({
  solution_type: z.literal("agent"),
  runtime_config: AgentRuntimeConfigSchema,
});

export const SolutionWorkflowSchema = SolutionBaseSchema.extend({
  solution_type: z.literal("workflow"),
  runtime_config: WorkflowRuntimeConfigSchema,
});

export const SolutionBundleSchema = SolutionBaseSchema.extend({
  solution_type: z.literal("bundle"),
  runtime_config: BundleRuntimeConfigSchema,
});

// The main discriminated union — parse at the API boundary
export const SolutionSchema = z.discriminatedUnion("solution_type", [
  SolutionSaasSchema,
  SolutionAgentSchema,
  SolutionWorkflowSchema,
  SolutionBundleSchema,
]);

export type SolutionSaas = z.infer<typeof SolutionSaasSchema>;
export type SolutionAgent = z.infer<typeof SolutionAgentSchema>;
export type SolutionWorkflow = z.infer<typeof SolutionWorkflowSchema>;
export type SolutionBundle = z.infer<typeof SolutionBundleSchema>;
export type Solution = z.infer<typeof SolutionSchema>;

// ---------------------------------------------------------------------------
// Input schemas — for create/update actions
// ---------------------------------------------------------------------------

export const CreateSolutionInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  category: z.string().optional(),
  price_cents: z.number().int().nonnegative(),
  min_price_cents: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).default("usd"),
  auth_url: z.string().url().optional(),
  solution_type: SolutionTypeSchema.default("saas"),
  runtime_config: z.record(z.string(), z.unknown()).optional(),
  is_template: z.boolean().default(false),
  affiliate_commission_bps: z
    .number()
    .int()
    .min(2000)
    .max(8000)
    .optional()
    .nullable(),
  has_free_trial: z.boolean().default(false),
  // #44 metered product fields
  product_kind: ProductKindSchema.default("hosted").optional(),
  meter_id: z.string().uuid().optional().nullable(),
  vendor_unit_price_cents: z.number().int().nonnegative().optional().nullable(),
  min_unit_price_cents: z.number().int().nonnegative().optional().nullable(),
});

export type CreateSolutionInput = z.infer<typeof CreateSolutionInputSchema>;

export const UpdateSolutionInputSchema = CreateSolutionInputSchema.partial().extend({
  solution_version: SemverSchema.optional(),
});

export type UpdateSolutionInput = z.infer<typeof UpdateSolutionInputSchema>;

// ---------------------------------------------------------------------------
// solution_versions row type
// ---------------------------------------------------------------------------

export const SolutionVersionSchema = z.object({
  id: z.string().uuid(),
  solution_id: z.string().uuid(),
  version: SemverSchema,
  runtime_config: z.record(z.string(), z.unknown()).nullable(),
  changelog: z.string().nullable(),
  published_at: z.string().datetime(),
  published_by: z.string().uuid().nullable(),
  tenant_shard_id: z.number().int().default(0),
});

export type SolutionVersion = z.infer<typeof SolutionVersionSchema>;

// ---------------------------------------------------------------------------
// Feature flag helper
// ---------------------------------------------------------------------------

export function isNonSaasEnabled(): boolean {
  return process.env.SOLUTIONS_NON_SAAS_ENABLED === "true";
}

export function assertSolutionTypeAllowed(type: SolutionType): void {
  if (type !== "saas" && !isNonSaasEnabled()) {
    throw new Error(
      `Solution type '${type}' is not yet enabled. Set SOLUTIONS_NON_SAAS_ENABLED=true to enable agent/workflow/bundle types.`
    );
  }
}
