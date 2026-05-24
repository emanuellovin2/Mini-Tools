// ---------------------------------------------------------------------------
// solutions.ts — Wave 9 solution-aware service layer
// ---------------------------------------------------------------------------
// This file extends (not replaces) lib/services/apps.ts.
// apps.ts continues to export marketplace query functions used by pages.
// solutions.ts adds: solution-version management, template fork, vendor
//   solution CRUD with type enforcement, and solution_versions history.
//
// Import from here for anything solution-type-aware;
// import from apps.ts for marketplace read queries (they go through the view).
// ---------------------------------------------------------------------------

import { createAdminClient } from "@/lib/services/supabase";
import { withStandardTimeout } from "@/lib/db/with-timeout";
import {
  assertSolutionTypeAllowed,
  SolutionVersionSchema,
  type SolutionType,
  type SolutionVersion,
  type CreateSolutionInput,
  type UpdateSolutionInput,
} from "@/lib/types/solutions";

// Re-export apps.ts helpers so callers can migrate import paths gradually
export {
  listMarketplaceApps,
  getFeaturedApps,
  getMarketplaceApp,
  listMarketplaceCategories,
  listAppReviews,
  createReview,
  respondToReview,
  moderateReview,
  formatPrice,
  formatRating,
  type MarketplaceApp,
  type MarketplaceAppDetail,
  type MarketplaceListResult,
  type MarketplaceSort,
  type FeaturedApp,
  type AppReview,
  type ReviewListResult,
  MARKETPLACE_PAGE_SIZE,
} from "@/lib/services/apps";

// ---------------------------------------------------------------------------
// Vendor CRUD for solutions (org-scoped, type-gated)
// ---------------------------------------------------------------------------

export async function createSolution(
  orgId: string,
  vendorId: string,
  input: CreateSolutionInput
): Promise<string> {
  assertSolutionTypeAllowed(input.solution_type ?? "saas");

  const admin = createAdminClient();

  return withStandardTimeout(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin.from as any)("solutions").insert({
      org_id: orgId,
      vendor_id: vendorId,
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? null,
      price_cents: input.price_cents,
      min_price_cents: input.min_price_cents ?? null,
      currency: input.currency ?? "usd",
      auth_url: input.auth_url ?? null,
      solution_type: input.solution_type ?? "saas",
      runtime_config: input.runtime_config ?? null,
      is_template: input.is_template ?? false,
      has_free_trial: input.has_free_trial ?? false,
      affiliate_commission_bps: input.affiliate_commission_bps ?? null,
    }).select("id").single();

    if (error) throw new Error(`createSolution: ${error.message}`);
    return (data as { id: string }).id;
  });
}

export async function updateSolution(
  solutionId: string,
  orgId: string,
  input: UpdateSolutionInput
): Promise<void> {
  if (input.solution_type) assertSolutionTypeAllowed(input.solution_type);

  const admin = createAdminClient();

  return withStandardTimeout(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin.from as any)("solutions")
      .update({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.category !== undefined && { category: input.category }),
        ...(input.price_cents !== undefined && { price_cents: input.price_cents }),
        ...(input.min_price_cents !== undefined && { min_price_cents: input.min_price_cents }),
        ...(input.auth_url !== undefined && { auth_url: input.auth_url }),
        ...(input.runtime_config !== undefined && { runtime_config: input.runtime_config }),
        ...(input.is_template !== undefined && { is_template: input.is_template }),
        ...(input.has_free_trial !== undefined && { has_free_trial: input.has_free_trial }),
        ...(input.affiliate_commission_bps !== undefined && {
          affiliate_commission_bps: input.affiliate_commission_bps,
        }),
        ...(input.solution_version !== undefined && { solution_version: input.solution_version }),
      })
      .eq("id", solutionId)
      .eq("org_id", orgId); // org scope enforced server-side

    if (error) throw new Error(`updateSolution: ${error.message}`);
  });
}

export async function softDeleteSolution(
  solutionId: string,
  orgId: string
): Promise<void> {
  const admin = createAdminClient();

  return withStandardTimeout(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin.from as any)("solutions")
      .update({ status: "deleted" })
      .eq("id", solutionId)
      .eq("org_id", orgId);

    if (error) throw new Error(`softDeleteSolution: ${error.message}`);
  });
}

// ---------------------------------------------------------------------------
// Template fork — creates a new agency-owned solution from a vendor template
// ---------------------------------------------------------------------------

export async function forkSolutionTemplate(
  templateId: string,
  forkingOrgId: string,
  forkingVendorId: string,
  overrides?: Partial<Pick<CreateSolutionInput, "name" | "description" | "runtime_config">>
): Promise<string> {
  const admin = createAdminClient();

  return withStandardTimeout(async () => {
    // Fetch template — must be published and marked is_template=true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tmpl, error: fetchErr } = await (admin.from as any)("solutions")
      .select("*")
      .eq("id", templateId)
      .eq("is_template", true)
      .eq("status", "approved")
      .single();

    if (fetchErr || !tmpl) {
      throw new Error(`forkSolutionTemplate: template ${templateId} not found or not public`);
    }

    assertSolutionTypeAllowed(tmpl.solution_type as SolutionType);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error: insertErr } = await (admin.from as any)("solutions").insert({
      org_id: forkingOrgId,
      vendor_id: forkingVendorId,
      name: overrides?.name ?? `${tmpl.name} (fork)`,
      description: overrides?.description ?? tmpl.description,
      category: tmpl.category,
      price_cents: tmpl.price_cents,
      min_price_cents: tmpl.min_price_cents,
      currency: tmpl.currency,
      auth_url: tmpl.auth_url,
      solution_type: tmpl.solution_type,
      runtime_config: overrides?.runtime_config ?? tmpl.runtime_config,
      template_of_id: templateId,
      is_template: false,
      has_free_trial: tmpl.has_free_trial,
      affiliate_commission_bps: tmpl.affiliate_commission_bps,
      status: "pending", // fork must be re-approved (admin reviews the override)
    }).select("id").single();

    if (insertErr) throw new Error(`forkSolutionTemplate: ${insertErr.message}`);
    return (data as { id: string }).id;
  });
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

export async function publishSolutionVersion(
  solutionId: string,
  orgId: string,
  publishedBy: string,
  version: string,
  options?: { runtimeConfig?: Record<string, unknown>; changelog?: string }
): Promise<SolutionVersion> {
  const admin = createAdminClient();

  return withStandardTimeout(async () => {
    // Verify org owns this solution
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sol } = await (admin.from as any)("solutions")
      .select("id")
      .eq("id", solutionId)
      .eq("org_id", orgId)
      .single();

    if (!sol) throw new Error(`publishSolutionVersion: solution ${solutionId} not found`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin.from as any)("solution_versions").insert({
      solution_id: solutionId,
      version,
      runtime_config: options?.runtimeConfig ?? null,
      changelog: options?.changelog ?? null,
      published_by: publishedBy,
    }).select("*").single();

    if (error) throw new Error(`publishSolutionVersion: ${error.message}`);

    // Also bump solution_version on the solution row
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin.from as any)("solutions")
      .update({ solution_version: version })
      .eq("id", solutionId);

    return SolutionVersionSchema.parse(data);
  });
}

export async function listSolutionVersions(
  solutionId: string,
  orgId: string,
  limit = 20
): Promise<SolutionVersion[]> {
  const admin = createAdminClient();

  return withStandardTimeout(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin.from as any)("solution_versions")
      .select("*, solutions!inner(org_id)")
      .eq("solution_id", solutionId)
      .eq("solutions.org_id", orgId)
      .order("published_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(`listSolutionVersions: ${error.message}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((data ?? []) as any[]).map((r) =>
      SolutionVersionSchema.parse({ ...r, solutions: undefined })
    );
  });
}

// ---------------------------------------------------------------------------
// Vendor solution listing (org-scoped, includes all statuses)
// ---------------------------------------------------------------------------

export type VendorSolutionRow = {
  id: string;
  name: string;
  status: string;
  solution_type: SolutionType;
  solution_version: string;
  is_template: boolean;
  template_of_id: string | null;
  price_cents: number;
  rating_avg: number;
  rating_count: number;
  created_at: string;
};

export async function listVendorSolutions(
  orgId: string,
  type?: SolutionType
): Promise<VendorSolutionRow[]> {
  const admin = createAdminClient();

  return withStandardTimeout(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q = (admin.from as any)("solutions")
      .select(
        "id, name, status, solution_type, solution_version, is_template, template_of_id, price_cents, rating_avg, rating_count, created_at"
      )
      .eq("org_id", orgId)
      .neq("status", "deleted")
      .order("created_at", { ascending: false });

    if (type) q = q.eq("solution_type", type);

    const { data, error } = await q;
    if (error) throw new Error(`listVendorSolutions: ${error.message}`);
    return (data ?? []) as VendorSolutionRow[];
  });
}
