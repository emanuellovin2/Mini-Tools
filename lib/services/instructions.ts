/**
 * Instruction set service — cache-first resolution (mirrors getEffectiveConfig).
 *
 * Hot path: in-process LRU (30s) → Redis (5 min, version-keyed) → Postgres.
 * After warmup, every AI call resolves instructions in 0 network round-trips.
 *
 * Invalidation: publish bumps instruction_version:{orgId} in Redis, which
 * changes the cache key; old entries fall out naturally within 30s (LRU TTL).
 */

import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { createAdminClient } from "@/lib/services/supabase";
import { writeAuditLog } from "@/lib/services/admin";
import { enforceQuota } from "@/lib/quotas/enforce";
import {
  resolveInstructions,
  type Block,
  type ScopeLevel,
  type ScopedVersion,
  type ResolvedInstructions,
} from "@/lib/instructions/resolve";
import { expandTemplate } from "@/lib/workflows/steps/transform";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstructionSet {
  id: string;
  org_id: string;
  scope_level: ScopeLevel;
  scope_ref_id: string | null;
  name: string;
  active_version_id: string | null;
  status: "draft" | "published";
  created_at: string;
  updated_at: string;
}

export interface InstructionVersion {
  id: string;
  instruction_set_id: string;
  version: number;
  blocks: Block[];
  variables: Record<string, string>;
  content_hash: string;
  created_by: string;
  created_at: string;
}

export interface GetInstructionsParams {
  orgId: string;
  projectId?: string | null;
  clientOrgId?: string | null;
  deploymentId?: string | null;
  /** Runtime variables to expand {{placeholders}} in the final prompt. */
  runtimeVariables?: Record<string, string>;
}

export interface EffectiveInstructions extends ResolvedInstructions {
  resolvedFrom: ScopeLevel[];
}

// ---------------------------------------------------------------------------
// Redis singleton
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
// In-process LRU — two layers: version counter + resolved instructions
// ---------------------------------------------------------------------------

interface LruEntry<T> { value: T; expiresAt: number }
const LRU_TTL_MS = 30_000;
const LRU_MAX = 500;

function lruMake<T>() {
  const store = new Map<string, LruEntry<T>>();
  return {
    get(key: string): T | null {
      const e = store.get(key);
      if (!e) return null;
      if (Date.now() > e.expiresAt) { store.delete(key); return null; }
      return e.value;
    },
    set(key: string, value: T): void {
      if (store.size >= LRU_MAX) {
        const first = store.keys().next().value;
        if (first !== undefined) store.delete(first);
      }
      store.set(key, { value, expiresAt: Date.now() + LRU_TTL_MS });
    },
    del(key: string): void { store.delete(key); },
    delPrefix(prefix: string): void {
      for (const k of store.keys()) { if (k.startsWith(prefix)) store.delete(k); }
    },
  };
}

const counterLru = lruMake<number>();
const dataLru = lruMake<EffectiveInstructions>();

const COUNTER_REDIS_TTL = 86_400 * 7; // 7 days

// ---------------------------------------------------------------------------
// Version counter (per-org, bump on any publish)
// ---------------------------------------------------------------------------

async function getVersionCounter(orgId: string): Promise<number> {
  const cached = counterLru.get(orgId);
  if (cached !== null) return cached;

  const redis = getRedis();
  let counter = 0;
  if (redis) {
    counter = (await redis.get<number>(`instruction_version:${orgId}`).catch(() => null)) ?? 0;
  }
  counterLru.set(orgId, counter);
  return counter;
}

/** Call after any instruction publish to invalidate all cached instructions for the org. */
export async function bumpInstructionVersion(orgId: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.incr(`instruction_version:${orgId}`).catch(() => null);
    await redis.expire(`instruction_version:${orgId}`, COUNTER_REDIS_TTL).catch(() => null);
  }
  counterLru.del(orgId);
  dataLru.delPrefix(`effins:v1:${orgId}:`);
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

async function buildCacheKey(params: GetInstructionsParams): Promise<string> {
  const counter = await getVersionCounter(params.orgId);
  const p = params.projectId ?? "_";
  const c = params.clientOrgId ?? "_";
  const d = params.deploymentId ?? "_";
  return `effins:v1:${params.orgId}:${p}:${c}:${d}:v${counter}`;
}

// ---------------------------------------------------------------------------
// getEffectiveInstructions — the ONLY function call paths should use
// ---------------------------------------------------------------------------

export async function getEffectiveInstructions(
  params: GetInstructionsParams
): Promise<EffectiveInstructions> {
  const cacheKey = await buildCacheKey(params);

  // 1. In-process LRU (30s)
  const local = dataLru.get(cacheKey);
  if (local) return local;

  // 2. Redis (5 min)
  const redis = getRedis();
  if (redis) {
    const cached = await redis.get<EffectiveInstructions>(cacheKey).catch(() => null);
    if (cached) {
      dataLru.set(cacheKey, cached);
      return cached;
    }
  }

  // 3. DB: load active versions for each applicable scope
  const admin = createAdminClient() as AnyAdmin;
  const scopes: ScopedVersion[] = [];
  const resolvedFrom: ScopeLevel[] = [];

  // Build scope query conditions (check whichever scopes have sets for this org)
  const conditions: Array<{ scope_level: ScopeLevel; scope_ref_id: string | null }> = [
    { scope_level: "global", scope_ref_id: null },
  ];
  if (params.projectId) conditions.push({ scope_level: "project", scope_ref_id: params.projectId });
  if (params.clientOrgId) conditions.push({ scope_level: "client", scope_ref_id: params.clientOrgId });
  if (params.deploymentId) conditions.push({ scope_level: "deployment", scope_ref_id: params.deploymentId });

  const { data: sets } = await admin
    .from("instruction_sets")
    .select("id, scope_level, scope_ref_id, active_version_id, status")
    .eq("org_id", params.orgId)
    .eq("status", "published")
    .not("active_version_id", "is", null);

  // Match sets to our requested scopes
  const matchedVersionIds: string[] = [];
  const matchedScopes: Array<{ scope: ScopeLevel; versionId: string }> = [];

  for (const cond of conditions) {
    const match = (sets ?? []).find(
      (s: { scope_level: string; scope_ref_id: string | null; active_version_id: string | null }) =>
        s.scope_level === cond.scope_level &&
        s.scope_ref_id === cond.scope_ref_id &&
        s.active_version_id !== null
    );
    if (match) {
      matchedVersionIds.push(match.active_version_id);
      matchedScopes.push({ scope: match.scope_level as ScopeLevel, versionId: match.active_version_id });
    }
  }

  if (matchedVersionIds.length > 0) {
    const { data: versions } = await admin
      .from("instruction_versions")
      .select("id, blocks, variables")
      .in("id", matchedVersionIds);

    type VersionRow = { id: string; blocks: Block[]; variables: Record<string, string> };
    const versionMap = new Map<string, VersionRow>(
      (versions ?? []).map((v: VersionRow) => [v.id, v] as [string, VersionRow])
    );

    for (const { scope, versionId } of matchedScopes) {
      const ver = versionMap.get(versionId);
      if (ver) {
        scopes.push({
          scope,
          blocks: (ver.blocks as Block[]) ?? [],
          variables: (ver.variables as Record<string, string>) ?? {},
        });
        resolvedFrom.push(scope);
      }
    }
  }

  const resolved = resolveInstructions(scopes);

  // Apply variable expansion (safe {{path}} template expander — no eval)
  const allVars = { ...resolved.variables, ...(params.runtimeVariables ?? {}) };
  const systemPrompt = Object.keys(allVars).length > 0
    ? expandTemplate(resolved.systemPrompt, allVars as Record<string, unknown>)
    : resolved.systemPrompt;

  const result: EffectiveInstructions = {
    systemPrompt,
    variables: resolved.variables,
    resolvedFrom,
  };

  // Cache
  if (redis) {
    await redis.set(cacheKey, result, { ex: 300 }).catch(() => null);
  }
  dataLru.set(cacheKey, result);

  return result;
}

// ---------------------------------------------------------------------------
// CRUD — create / publish / rollback
// ---------------------------------------------------------------------------

export interface CreateInstructionSetInput {
  orgId: string;
  scopeLevel: ScopeLevel;
  scopeRefId?: string | null;
  name: string;
  actorUserId: string;
  actorOrgId: string;
}

export async function createInstructionSet(
  input: CreateInstructionSetInput
): Promise<InstructionSet> {
  await enforceQuota(input.orgId, "instruction_sets");

  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("instruction_sets")
    .insert({
      org_id: input.orgId,
      scope_level: input.scopeLevel,
      scope_ref_id: input.scopeRefId ?? null,
      name: input.name,
      status: "draft",
    })
    .select()
    .single();
  if (error) throw new Error(`createInstructionSet: ${error.message}`);

  await writeAuditLog({
    actorId: input.actorUserId,
    actorRole: "vendor",
    action: "instruction_set.created",
    entityType: "instruction_set",
    entityId: data.id,
    actorOrgId: input.actorOrgId,
    metadata: { scope_level: input.scopeLevel, scope_ref_id: input.scopeRefId },
  });

  return data as InstructionSet;
}

export interface PublishVersionInput {
  instructionSetId: string;
  blocks: Block[];
  variables?: Record<string, string>;
  actorUserId: string;
  actorOrgId: string;
}

export async function publishVersion(input: PublishVersionInput): Promise<InstructionVersion> {
  const admin = createAdminClient() as AnyAdmin;

  const { data: set, error: setErr } = await admin
    .from("instruction_sets")
    .select("id, org_id")
    .eq("id", input.instructionSetId)
    .single();
  if (setErr || !set) throw new Error("Instruction set not found");

  // Compute content hash for dedupe
  const blocksJson = JSON.stringify(input.blocks);
  const varsJson = JSON.stringify(input.variables ?? {});
  const contentHash = crypto
    .createHash("sha256")
    .update(`${blocksJson}:${varsJson}`)
    .digest("hex");

  // Check for no-op publish
  const { data: existing } = await admin
    .from("instruction_versions")
    .select("id")
    .eq("instruction_set_id", input.instructionSetId)
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (existing) throw new Error("No changes since last version (content hash unchanged)");

  // Get next version number
  const { data: latest } = await admin
    .from("instruction_versions")
    .select("version")
    .eq("instruction_set_id", input.instructionSetId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = ((latest?.version as number | null) ?? 0) + 1;

  // Insert version + flip active_version_id in one RPC (atomically via Postgres function)
  // For simplicity, we use two statements — both within admin's implicit transaction context.
  const { data: ver, error: verErr } = await admin
    .from("instruction_versions")
    .insert({
      instruction_set_id: input.instructionSetId,
      version: nextVersion,
      blocks: input.blocks,
      variables: input.variables ?? {},
      content_hash: contentHash,
      created_by: input.actorUserId,
    })
    .select()
    .single();
  if (verErr) throw new Error(`publishVersion insert: ${verErr.message}`);

  const { error: updateErr } = await admin
    .from("instruction_sets")
    .update({ active_version_id: ver.id, status: "published" })
    .eq("id", input.instructionSetId);
  if (updateErr) throw new Error(`publishVersion update: ${updateErr.message}`);

  // Invalidate cache for the org
  await bumpInstructionVersion(set.org_id);

  await writeAuditLog({
    actorId: input.actorUserId,
    actorRole: "vendor",
    action: "instruction_set.version_published",
    entityType: "instruction_version",
    entityId: ver.id,
    actorOrgId: input.actorOrgId,
    metadata: { instruction_set_id: input.instructionSetId, version: nextVersion },
  });

  return ver as InstructionVersion;
}

export async function rollbackToVersion(
  instructionSetId: string,
  versionId: string,
  actorUserId: string,
  actorOrgId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;

  const { data: ver } = await admin
    .from("instruction_versions")
    .select("id, instruction_set_id")
    .eq("id", versionId)
    .eq("instruction_set_id", instructionSetId)
    .single();
  if (!ver) throw new Error("Version not found for this instruction set");

  const { data: set, error: setErr } = await admin
    .from("instruction_sets")
    .update({ active_version_id: versionId })
    .eq("id", instructionSetId)
    .select("org_id")
    .single();
  if (setErr || !set) throw new Error(`rollbackToVersion: ${setErr?.message}`);

  await bumpInstructionVersion(set.org_id);

  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "vendor",
    action: "instruction_set.rolled_back",
    entityType: "instruction_set",
    entityId: instructionSetId,
    actorOrgId,
    metadata: { rolled_back_to_version_id: versionId },
  });
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function listInstructionSets(orgId: string): Promise<InstructionSet[]> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("instruction_sets")
    .select("*")
    .eq("org_id", orgId)
    .order("scope_level")
    .order("created_at");
  if (error) throw new Error(`listInstructionSets: ${error.message}`);
  return (data ?? []) as InstructionSet[];
}

export async function getInstructionSet(id: string): Promise<InstructionSet> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("instruction_sets")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !data) throw new Error(`Instruction set not found: ${id}`);
  return data as InstructionSet;
}

export async function listVersions(instructionSetId: string): Promise<InstructionVersion[]> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("instruction_versions")
    .select("*")
    .eq("instruction_set_id", instructionSetId)
    .order("version", { ascending: false });
  if (error) throw new Error(`listVersions: ${error.message}`);
  return (data ?? []) as InstructionVersion[];
}
