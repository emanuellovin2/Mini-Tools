import { createAdminClient } from "@/lib/services/supabase";

export const QUOTA_EXCEEDED = "QUOTA_EXCEEDED" as const;

export class QuotaExceededError extends Error {
  readonly code = QUOTA_EXCEEDED;
  constructor(
    public readonly resource: Resource,
    public readonly limit: number,
    public readonly used: number
  ) {
    super(`Quota exceeded for ${resource}: limit=${limit}, used=${used}`);
    this.name = "QuotaExceededError";
  }
}

// All resources that have quota columns in org_quotas
export type Resource =
  | "offers"
  | "api_keys"
  | "workflows"
  | "affiliate_links"
  | "connectors"
  | "webhook_endpoints"
  | "workflow_steps"
  | "partner_clients"
  // Wave 9 (#54) — agency/client/deployment resources
  | "active_deployments"
  | "clients"
  // #41 — AI Gateway
  | "provider_keys"
  | "gateway_tokens"
  // #44 — Usage-product distribution
  | "reseller_metered_offers";

interface ResourceConfig {
  quotaCol: string;
  table: string;
  orgCol: string;
}

// Map from resource to (quota column, count query table + column)
const RESOURCE_CONFIG: Record<Resource, ResourceConfig> = {
  offers:            { quotaCol: "max_offers",            table: "reseller_offers",    orgCol: "org_id" },
  api_keys:          { quotaCol: "max_api_keys",          table: "api_keys",           orgCol: "org_id" },
  workflows:         { quotaCol: "max_workflows",         table: "workflows",          orgCol: "org_id" },
  affiliate_links:   { quotaCol: "max_affiliate_links",   table: "affiliate_links",    orgCol: "org_id" },
  connectors:        { quotaCol: "max_connectors",        table: "connector_accounts", orgCol: "org_id" },
  webhook_endpoints: { quotaCol: "max_webhook_endpoints", table: "vendor_webhooks",    orgCol: "org_id" },
  workflow_steps:    { quotaCol: "max_workflow_steps",    table: "workflow_steps",     orgCol: "org_id" },
  partner_clients:    { quotaCol: "max_partner_clients",    table: "partner_clients",       orgCol: "org_id" },
  // Wave 9 (#54) — tables created in #50; entries here so enforceQuota works from day 1.
  active_deployments: { quotaCol: "max_active_deployments", table: "solution_deployments",   orgCol: "agency_org_id" },
  clients:            { quotaCol: "max_clients",             table: "client_relationships",   orgCol: "agency_org_id" },
  // #41 — AI Gateway
  provider_keys:  { quotaCol: "max_provider_keys",  table: "provider_keys",  orgCol: "owner_id" },
  gateway_tokens: { quotaCol: "max_gateway_tokens", table: "gateway_tokens", orgCol: "owner_id" },
  // #44 — Usage-product distribution
  reseller_metered_offers: { quotaCol: "max_count", table: "reseller_metered_offers", orgCol: "org_id" },
};

// org_quotas and several referenced tables are not yet in generated types —
// cast via any until `npm run types` is run after migrations apply.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = ReturnType<typeof createAdminClient> & { from: any };

// Throws QuotaExceededError if the org is at or over the limit for `resource`.
// Must be called before any INSERT in the creation path (server action / API route).
export async function enforceQuota(orgId: string, resource: Resource): Promise<void> {
  const admin = createAdminClient() as AnyClient;
  const cfg = RESOURCE_CONFIG[resource];

  const [quotaRes, countRes] = await Promise.all([
    admin.from("org_quotas").select(cfg.quotaCol).eq("org_id", orgId).single(),
    admin
      .from(cfg.table)
      .select("id", { count: "exact", head: true })
      .eq(cfg.orgCol, orgId),
  ]);

  if (quotaRes.error) throw new Error(`enforceQuota: ${(quotaRes.error as { message: string }).message}`);

  const limit = (quotaRes.data as Record<string, number>)[cfg.quotaCol] ?? 0;
  const used = (countRes.count as number | null) ?? 0;

  if (used >= limit) throw new QuotaExceededError(resource, limit, used);
}

export interface QuotaUsage {
  resource: Resource;
  used: number;
  limit: number;
}

// Returns current usage vs limit for all resources in an org.
export async function getQuotaUsage(orgId: string): Promise<QuotaUsage[]> {
  const admin = createAdminClient() as AnyClient;

  const { data: quotas, error } = await admin
    .from("org_quotas")
    .select("*")
    .eq("org_id", orgId)
    .single();
  if (error) throw new Error(`getQuotaUsage: ${(error as { message: string }).message}`);

  const results: QuotaUsage[] = [];

  for (const [resource, cfg] of Object.entries(RESOURCE_CONFIG) as [Resource, ResourceConfig][]) {
    const { count } = await admin
      .from(cfg.table)
      .select("id", { count: "exact", head: true })
      .eq(cfg.orgCol, orgId);

    results.push({
      resource,
      used: (count as number | null) ?? 0,
      limit: (quotas as Record<string, number>)[cfg.quotaCol] ?? 0,
    });
  }

  return results;
}
