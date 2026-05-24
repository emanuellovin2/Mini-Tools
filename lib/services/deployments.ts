import { Redis } from "@upstash/redis";
import { createAdminClient } from "@/lib/services/supabase";
import { writeAuditLog } from "@/lib/services/admin";
import { enforceQuota } from "@/lib/quotas/enforce";

// solution_deployments is not in generated Database type yet — use AnyAdmin until
// `npm run types` is run after `supabase db push`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;
import {
  AgentRuntimeConfigSchema,
  WorkflowRuntimeConfigSchema,
  BundleRuntimeConfigSchema,
  type SolutionType,
} from "@/lib/types/solutions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeploymentStatus =
  | "pending_setup"
  | "active"
  | "paused"
  | "failed"
  | "archived"
  | "orphaned";

export type CreditWalletOwner = "client" | "agency";

export interface SolutionDeployment {
  id: string;
  tenant_shard_id: number;
  solution_id: string;
  client_org_id: string;
  agency_org_id: string | null;
  template_origin_id: string | null;
  status: DeploymentStatus;
  runtime_config_override: Record<string, unknown> | null;
  branding: { logo_url?: string; brand_color?: string; display_name?: string } | null;
  credit_wallet_owner: CreditWalletOwner;
  region: string;
  created_at: string;
  activated_at: string | null;
  paused_until: string | null;
  archived_at: string | null;
}

export interface EffectiveConfig {
  deployment_id: string;
  solution_type: SolutionType;
  config: Record<string, unknown>;
  status: DeploymentStatus;
  credit_wallet_owner: CreditWalletOwner;
}

// ---------------------------------------------------------------------------
// Redis singleton (shared with rate-limit.ts — both read the same env vars)
// ---------------------------------------------------------------------------

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

// ---------------------------------------------------------------------------
// In-process LRU (30-second TTL, max 500 entries)
// Sits in front of Redis so ultra-hot paths don't pay a network round-trip.
// Both tiers must be invalidated together on any config mutation.
// ---------------------------------------------------------------------------

interface LocalEntry {
  config: EffectiveConfig;
  expiresAt: number;
}

const LOCAL_CACHE = new Map<string, LocalEntry>();
const LOCAL_TTL_MS = 30_000;
const LOCAL_MAX = 500;

function localGet(key: string): EffectiveConfig | null {
  const entry = LOCAL_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    LOCAL_CACHE.delete(key);
    return null;
  }
  return entry.config;
}

function localSet(key: string, config: EffectiveConfig): void {
  if (LOCAL_CACHE.size >= LOCAL_MAX) {
    const firstKey = LOCAL_CACHE.keys().next().value;
    if (firstKey !== undefined) LOCAL_CACHE.delete(firstKey);
  }
  LOCAL_CACHE.set(key, { config, expiresAt: Date.now() + LOCAL_TTL_MS });
}

function localDel(key: string): void {
  LOCAL_CACHE.delete(key);
}

function cacheKey(deploymentId: string): string {
  return `effcfg:v1:${deploymentId}`;
}

// ---------------------------------------------------------------------------
// Runtime config validation (reuses #49 schemas, validates per solution type)
// ---------------------------------------------------------------------------

function validateRuntimeConfig(
  type: SolutionType,
  config: Record<string, unknown>
): void {
  const result =
    type === "agent"
      ? AgentRuntimeConfigSchema.safeParse(config)
      : type === "workflow"
      ? WorkflowRuntimeConfigSchema.safeParse(config)
      : type === "bundle"
      ? BundleRuntimeConfigSchema.safeParse(config)
      : null;

  if (result && !result.success) {
    throw new Error(`Invalid runtime_config for ${type}: ${result.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// createDeployment
// ---------------------------------------------------------------------------

export interface CreateDeploymentInput {
  solutionId: string;
  clientOrgId: string;
  agencyOrgId?: string | null;
  configOverride?: Record<string, unknown> | null;
  branding?: { logo_url?: string; brand_color?: string; display_name?: string } | null;
  walletOwner?: CreditWalletOwner;
  actorUserId: string;
  actorOrgId: string;
}

export async function createDeployment(input: CreateDeploymentInput): Promise<SolutionDeployment> {
  const admin = createAdminClient() as AnyAdmin;

  // Enforce deployment quota against the agency (or client if no agency)
  const quotaOrgId = input.agencyOrgId ?? input.clientOrgId;
  await enforceQuota(quotaOrgId, "active_deployments");

  // Resolve solution info (type + base config + template_of_id)
  const { data: solution, error: solErr } = await admin
    .from("solutions")
    .select("id, solution_type, runtime_config, template_of_id, org_id")
    .eq("id", input.solutionId)
    .single();
  if (solErr || !solution) throw new Error(`Solution not found: ${input.solutionId}`);
  if (solution.solution_type === "saas") {
    throw new Error("SaaS solutions use the subscription flow, not deployments");
  }

  // Validate the config override against the solution type
  if (input.configOverride) {
    validateRuntimeConfig(
      solution.solution_type as SolutionType,
      input.configOverride
    );
  }

  // Denormalize region from client org
  const { data: clientOrg } = await admin
    .from("organizations")
    .select("region")
    .eq("id", input.clientOrgId)
    .single();
  const region = (clientOrg as { region?: string } | null)?.region ?? "us-east-1";

  const now = new Date().toISOString();
  const { data: dep, error: depErr } = await admin
    .from("solution_deployments")
    .insert({
      solution_id: input.solutionId,
      client_org_id: input.clientOrgId,
      agency_org_id: input.agencyOrgId ?? null,
      template_origin_id: (solution.template_of_id as string | null) ?? null,
      status: "pending_setup",
      runtime_config_override: input.configOverride ?? null,
      branding: input.branding ?? null,
      credit_wallet_owner: input.walletOwner ?? "client",
      region,
    })
    .select()
    .single();
  if (depErr) throw new Error(`createDeployment: ${depErr.message}`);

  await writeAuditLog({
    actorId: input.actorUserId,
    actorRole: input.agencyOrgId ? "agency" : "client",
    action: "deployment.created",
    entityType: "solution_deployment",
    entityId: dep.id,
    actorOrgId: input.actorOrgId,
    metadata: {
      solution_id: input.solutionId,
      client_org_id: input.clientOrgId,
      agency_org_id: input.agencyOrgId ?? null,
    },
  });

  return dep as SolutionDeployment;
}

// ---------------------------------------------------------------------------
// updateRuntimeConfig — merge-patch; invalidates cache on success
// ---------------------------------------------------------------------------

export async function updateRuntimeConfig(
  deploymentId: string,
  partial: Record<string, unknown>,
  actorUserId: string,
  actorOrgId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;

  const { data: dep, error } = await admin
    .from("solution_deployments")
    .select("id, solution_id, runtime_config_override, status")
    .eq("id", deploymentId)
    .single();
  if (error || !dep) throw new Error("Deployment not found");
  if (dep.status === "archived") throw new Error("Cannot update config of an archived deployment");

  // Resolve solution type for validation
  const { data: solution } = await admin
    .from("solutions")
    .select("solution_type, runtime_config")
    .eq("id", dep.solution_id)
    .single();
  if (!solution) throw new Error("Solution not found");

  const merged = { ...(dep.runtime_config_override ?? {}), ...partial };
  validateRuntimeConfig(solution.solution_type as SolutionType, merged);

  await admin
    .from("solution_deployments")
    .update({ runtime_config_override: merged })
    .eq("id", deploymentId);

  await invalidateEffectiveConfig(deploymentId);

  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "agency",
    action: "deployment.config_updated",
    entityType: "solution_deployment",
    entityId: deploymentId,
    actorOrgId,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle state transitions
// ---------------------------------------------------------------------------

export async function activateDeployment(
  deploymentId: string,
  actorUserId: string,
  actorOrgId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { error } = await admin
    .from("solution_deployments")
    .update({ status: "active", activated_at: new Date().toISOString() })
    .eq("id", deploymentId)
    .in("status", ["pending_setup", "paused"]);
  if (error) throw new Error(`activateDeployment: ${error.message}`);

  await invalidateEffectiveConfig(deploymentId);
  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "agency",
    action: "deployment.activated",
    entityType: "solution_deployment",
    entityId: deploymentId,
    actorOrgId,
  });
}

export async function pauseDeployment(
  deploymentId: string,
  actorUserId: string,
  actorOrgId: string,
  until?: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { error } = await admin
    .from("solution_deployments")
    .update({ status: "paused", paused_until: until ?? null })
    .eq("id", deploymentId)
    .eq("status", "active");
  if (error) throw new Error(`pauseDeployment: ${error.message}`);

  await invalidateEffectiveConfig(deploymentId);
  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "agency",
    action: "deployment.paused",
    entityType: "solution_deployment",
    entityId: deploymentId,
    actorOrgId,
    metadata: { paused_until: until ?? null },
  });
}

export async function resumeDeployment(
  deploymentId: string,
  actorUserId: string,
  actorOrgId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { error } = await admin
    .from("solution_deployments")
    .update({ status: "active", paused_until: null })
    .eq("id", deploymentId)
    .eq("status", "paused");
  if (error) throw new Error(`resumeDeployment: ${error.message}`);

  await invalidateEffectiveConfig(deploymentId);
  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "agency",
    action: "deployment.resumed",
    entityType: "solution_deployment",
    entityId: deploymentId,
    actorOrgId,
  });
}

export async function archiveDeployment(
  deploymentId: string,
  actorUserId: string,
  actorOrgId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { error } = await admin
    .from("solution_deployments")
    .update({ status: "archived", archived_at: new Date().toISOString() })
    .eq("id", deploymentId)
    .not("status", "eq", "archived");
  if (error) throw new Error(`archiveDeployment: ${error.message}`);

  await invalidateEffectiveConfig(deploymentId);
  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "agency",
    action: "deployment.archived",
    entityType: "solution_deployment",
    entityId: deploymentId,
    actorOrgId,
  });
}

// Transfer orphaned deployment to a new agency (after client signs new relationship)
export async function transferOrphanedDeployment(
  deploymentId: string,
  newAgencyOrgId: string,
  actorUserId: string,
  actorOrgId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;

  const { data: dep, error } = await admin
    .from("solution_deployments")
    .select("id, client_org_id, status")
    .eq("id", deploymentId)
    .single();
  if (error || !dep) throw new Error("Deployment not found");
  if (dep.status !== "orphaned") throw new Error("Deployment is not orphaned");

  // Verify the new agency has an active relationship with the client
  const { data: rel } = await admin
    .from("client_relationships")
    .select("id")
    .eq("agency_org_id", newAgencyOrgId)
    .eq("client_org_id", dep.client_org_id)
    .eq("status", "active")
    .maybeSingle();
  if (!rel) throw new Error("New agency has no active relationship with this client");

  await admin
    .from("solution_deployments")
    .update({ agency_org_id: newAgencyOrgId, status: "active", activated_at: new Date().toISOString() })
    .eq("id", deploymentId);

  await invalidateEffectiveConfig(deploymentId);
  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "client",
    action: "deployment.transferred",
    entityType: "solution_deployment",
    entityId: deploymentId,
    actorOrgId,
    metadata: { new_agency_org_id: newAgencyOrgId },
  });
}

// ---------------------------------------------------------------------------
// getEffectiveConfig — Redis-cached (5 min) + in-process LRU (30s)
// This is the ONLY function #41 (gateway) and #42 (workflow runner) read at run time.
// ---------------------------------------------------------------------------

export async function getEffectiveConfig(deploymentId: string): Promise<EffectiveConfig> {
  const key = cacheKey(deploymentId);

  // 1. In-process LRU (30s)
  const local = localGet(key);
  if (local) return local;

  // 2. Redis (5 min)
  const redis = getRedis();
  if (redis) {
    const cached = await redis.get<EffectiveConfig>(key);
    if (cached) {
      localSet(key, cached);
      return cached;
    }
  }

  // 3. DB fetch and cache
  const admin = createAdminClient() as AnyAdmin;
  const { data: dep, error } = await admin
    .from("solution_deployments")
    .select(`
      id, status, credit_wallet_owner, runtime_config_override,
      solutions (solution_type, runtime_config)
    `)
    .eq("id", deploymentId)
    .single();

  if (error || !dep) throw new Error(`Deployment not found: ${deploymentId}`);

  const solution = dep.solutions as unknown as {
    solution_type: SolutionType;
    runtime_config: Record<string, unknown> | null;
  } | null;

  if (!solution) throw new Error(`Solution missing for deployment ${deploymentId}`);

  const config: EffectiveConfig = {
    deployment_id: deploymentId,
    solution_type: solution.solution_type,
    config: {
      ...(solution.runtime_config ?? {}),
      ...(dep.runtime_config_override ?? {}),
    },
    status: dep.status as DeploymentStatus,
    credit_wallet_owner: dep.credit_wallet_owner as CreditWalletOwner,
  };

  // Cache in both tiers
  if (redis) {
    await redis.set(key, config, { ex: 300 }); // 5 minutes
  }
  localSet(key, config);

  return config;
}

// ---------------------------------------------------------------------------
// Cache invalidation — must be called on any mutation to config or status
// ---------------------------------------------------------------------------

export async function invalidateEffectiveConfig(deploymentId: string): Promise<void> {
  const key = cacheKey(deploymentId);
  localDel(key);
  const redis = getRedis();
  if (redis) await redis.del(key);
}

/** Invalidates all deployments of a given solution (e.g., when base runtime_config changes). */
export async function invalidateSolutionDeployments(solutionId: string): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { data } = await admin
    .from("solution_deployments")
    .select("id")
    .eq("solution_id", solutionId)
    .in("status", ["active", "pending_setup", "paused"]);

  const redis = getRedis();
  await Promise.all(
    (data ?? []).map(async (row: { id: string }) => {
      const key = cacheKey(row.id);
      localDel(key);
      if (redis) await redis.del(key);
    })
  );
}

// ---------------------------------------------------------------------------
// Vendor aggregate stats (anti-poaching: no client/agency identity exposed)
// Wraps the SECURITY DEFINER get_vendor_deployment_stats() DB function.
// ---------------------------------------------------------------------------

export interface VendorDeploymentStat {
  solution_id: string;
  solution_name: string;
  active_count: number;
  pending_count: number;
  paused_count: number;
  total_count: number;
}

export async function getVendorDeploymentStats(
  vendorOrgId: string
): Promise<VendorDeploymentStat[]> {
  const admin = createAdminClient() as AnyAdmin;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any).rpc("get_vendor_deployment_stats", {
    p_vendor_org_id: vendorOrgId,
  });
  if (error) throw new Error(`getVendorDeploymentStats: ${error.message}`);
  return (data ?? []) as VendorDeploymentStat[];
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function getDeployment(deploymentId: string): Promise<SolutionDeployment> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("solution_deployments")
    .select("*")
    .eq("id", deploymentId)
    .single();
  if (error || !data) throw new Error(`Deployment not found: ${deploymentId}`);
  return data as SolutionDeployment;
}

export async function listClientDeployments(
  clientOrgId: string,
  status?: DeploymentStatus
): Promise<SolutionDeployment[]> {
  const admin = createAdminClient() as AnyAdmin;
  let q = admin
    .from("solution_deployments")
    .select("*")
    .eq("client_org_id", clientOrgId)
    .order("created_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new Error(`listClientDeployments: ${error.message}`);
  return (data ?? []) as SolutionDeployment[];
}

export async function listAgencyDeployments(
  agencyOrgId: string,
  status?: DeploymentStatus
): Promise<SolutionDeployment[]> {
  const admin = createAdminClient() as AnyAdmin;
  let q = admin
    .from("solution_deployments")
    .select("*")
    .eq("agency_org_id", agencyOrgId)
    .order("created_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new Error(`listAgencyDeployments: ${error.message}`);
  return (data ?? []) as SolutionDeployment[];
}
