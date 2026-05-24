import { createAdminClient } from "@/lib/services/supabase";
import { enqueueJob } from "@/lib/jobs/queue";

// outcomes.ts not yet in generated Database type — cast via any until `npm run types`
// is run after `supabase db push`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricUnit = "count" | "usd" | "hours" | "minutes" | "percent" | (string & {});

/** Volume class declared on `solutions.runtime_config.outcome_metrics[].volume_class`.
 *  high → jobs queue + batch insert; medium/low → sync direct insert. */
export type VolumeClass = "low" | "medium" | "high";

export interface DeclaredMetric {
  key: string;
  unit: MetricUnit;
  description?: string;
  expected_dimensions?: string[];
  volume_class?: VolumeClass;
}

export interface EmitMetricInput {
  deploymentId: string;
  key: string;
  value: number;
  unit: MetricUnit;
  dimensions?: Record<string, string>;
  idempotencyKey?: string;
  emittedAt?: string; // ISO timestamp; defaults to now()
}

export interface EmitMetricResult {
  ok: boolean;
  deduped: boolean;
  queued: boolean;
  throttled?: boolean;
}

export interface DeploymentOutcomesQuery {
  since?: string; // ISO date string
  until?: string;
  metricKeys?: string[];
}

export interface RollupRow {
  deployment_id: string;
  metric_key: string;
  metric_unit: string;
  dimensions_hash: string;
  date: string;
  total_value: string;
  raw_count: string;
  cardinality_overflow: boolean;
}

export interface OutcomeSummary {
  metric_key: string;
  metric_unit: string;
  total_value: number;
  trend_pct: number | null; // % change vs prior equal period
  per_deployment?: Array<{ deployment_id: string; total_value: number }>;
}

export interface BenchmarkResult {
  metric_key: string;
  metric_unit: string;
  median_value: number;
  p25_value: number;
  p75_value: number;
  deployment_count: number;
}

export interface BenchmarkResponse {
  insufficient_data?: true;
  benchmarks?: BenchmarkResult[];
}

// ---------------------------------------------------------------------------
// PII guard (mirrors DB CHECK — also applied at service layer before insert)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const PHONE_RE = /^\+?[\d\s\-(). ]{7,18}$/;
const PHONE_MIN_DIGITS_RE = /\d{7}/;
const PAN_RE = /^\d{13,19}$/;

export function hasPiiValue(v: string): boolean {
  if (EMAIL_RE.test(v)) return true;
  if (PHONE_RE.test(v) && PHONE_MIN_DIGITS_RE.test(v)) return true;
  if (PAN_RE.test(v)) return true;
  return false;
}

function validateDimensions(dims: Record<string, string>): void {
  const keys = Object.keys(dims);
  if (keys.length > 16) throw new Error("dimensions: max 16 keys");
  for (const [k, v] of Object.entries(dims)) {
    if (typeof v !== "string") throw new Error(`dimensions.${k}: value must be a string`);
    if (v.length > 64) throw new Error(`dimensions.${k}: value exceeds 64 chars`);
    if (hasPiiValue(v)) throw new Error(`dimensions.${k}: value looks like PII — outcome metrics must not carry PII`);
  }
}

const METRIC_KEY_RE = /^[a-z][a-z0-9._]*$/;

// Reserved namespace prefixes — validated at emit time for schema-as-code
export const RESERVED_NAMESPACES = [
  "lead",
  "meeting",
  "task",
  "time",
  "revenue",
  "cost",
  "quality",
] as const;

function validateMetricKey(key: string): void {
  if (!METRIC_KEY_RE.test(key)) {
    throw new Error(
      `metric_key "${key}" is invalid — must match ^[a-z][a-z0-9._]*$`
    );
  }
}

// ---------------------------------------------------------------------------
// Idempotency check — cross-partition 7-day window (app-layer belt-and-suspenders
// on top of the per-partition DB unique index)
// ---------------------------------------------------------------------------

async function checkDuplicate(
  admin: AnyAdmin,
  deploymentId: string,
  key: string,
  idempotencyKey: string
): Promise<boolean> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { count } = await admin
    .from("deployment_metrics")
    .select("id", { count: "exact", head: true })
    .eq("deployment_id", deploymentId)
    .eq("metric_key", key)
    .eq("idempotency_key", idempotencyKey)
    .gte("created_at", since);
  return (count as number | null ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Resolve volume_class from solution runtime_config
// ---------------------------------------------------------------------------

async function resolveVolumeClass(
  admin: AnyAdmin,
  deploymentId: string,
  key: string
): Promise<VolumeClass> {
  const { data: dep } = await admin
    .from("solution_deployments")
    .select("solution_id")
    .eq("id", deploymentId)
    .single();
  if (!dep) return "medium";

  const { data: sol } = await admin
    .from("solutions")
    .select("runtime_config")
    .eq("id", dep.solution_id)
    .single();
  if (!sol?.runtime_config) return "medium";

  const declared: DeclaredMetric[] = (sol.runtime_config as Record<string, unknown>)
    .outcome_metrics as DeclaredMetric[] ?? [];
  const found = declared.find((m) => m.key === key);
  return found?.volume_class ?? "medium";
}

// ---------------------------------------------------------------------------
// Validate emitted metric against declared schema (schema-as-code).
// After the first emit from a deployment, only pre-declared keys are accepted.
// Unknown keys on first emit are allowed (they lock the schema for that deployment).
// ---------------------------------------------------------------------------

async function validateAgainstDeclaredSchema(
  admin: AnyAdmin,
  deploymentId: string,
  key: string,
  dimensions: Record<string, string>
): Promise<void> {
  const { data: dep } = await admin
    .from("solution_deployments")
    .select("solution_id")
    .eq("id", deploymentId)
    .single();
  if (!dep) return;

  const { data: sol } = await admin
    .from("solutions")
    .select("runtime_config")
    .eq("id", dep.solution_id)
    .single();
  if (!sol?.runtime_config) return;

  const declared: DeclaredMetric[] =
    (sol.runtime_config as Record<string, unknown>).outcome_metrics as DeclaredMetric[] ?? [];

  // If no outcome_metrics declared, allow (first emit auto-registers)
  if (declared.length === 0) return;

  const schema = declared.find((m) => m.key === key);
  if (!schema) {
    // Reject: schema is locked after first declaration
    throw new Error(
      `metric_key "${key}" is not declared in solution outcome_metrics schema. ` +
      `Add it to solutions.runtime_config.outcome_metrics before emitting.`
    );
  }

  // Validate expected dimensions if declared
  if (schema.expected_dimensions && schema.expected_dimensions.length > 0) {
    const dimKeys = Object.keys(dimensions);
    const unexpected = dimKeys.filter((k) => !schema.expected_dimensions!.includes(k));
    if (unexpected.length > 0) {
      throw new Error(
        `Unexpected dimension keys for "${key}": ${unexpected.join(", ")}. ` +
        `Expected: ${schema.expected_dimensions.join(", ")}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// emitMetric — the only write path
// ---------------------------------------------------------------------------

export async function emitMetric(input: EmitMetricInput): Promise<EmitMetricResult> {
  validateMetricKey(input.key);
  const dims = input.dimensions ?? {};
  validateDimensions(dims);

  const admin = createAdminClient() as AnyAdmin;

  // Schema-as-code validation
  await validateAgainstDeclaredSchema(admin, input.deploymentId, input.key, dims);

  // Cross-partition idempotency check
  if (input.idempotencyKey) {
    const isDup = await checkDuplicate(admin, input.deploymentId, input.key, input.idempotencyKey);
    if (isDup) return { ok: true, deduped: true, queued: false };
  }

  const volumeClass = await resolveVolumeClass(admin, input.deploymentId, input.key);

  if (volumeClass === "high") {
    // Enqueue for batch-insert worker
    await enqueueJob("outcome_emit_batch", {
      deploymentId: input.deploymentId,
      key: input.key,
      value: input.value,
      unit: input.unit,
      dimensions: dims,
      idempotencyKey: input.idempotencyKey ?? null,
      emittedAt: input.emittedAt ?? new Date().toISOString(),
    });
    return { ok: true, deduped: false, queued: true };
  }

  // low / medium: sync direct insert
  const { error } = await admin.from("deployment_metrics").insert({
    deployment_id: input.deploymentId,
    metric_key: input.key,
    metric_value: input.value,
    metric_unit: input.unit,
    dimensions: dims,
    idempotency_key: input.idempotencyKey ?? null,
    emitted_at: input.emittedAt ?? new Date().toISOString(),
  });

  if (error) {
    // 23505 = unique_violation (race on idempotency_key within same partition)
    if ((error as { code?: string }).code === "23505") {
      return { ok: true, deduped: true, queued: false };
    }
    throw new Error(`emitMetric: ${error.message}`);
  }

  return { ok: true, deduped: false, queued: false };
}

// ---------------------------------------------------------------------------
// getDeploymentOutcomes — time-series from rollup (RLS-gated)
// ---------------------------------------------------------------------------

export async function getDeploymentOutcomes(
  deploymentId: string,
  query: DeploymentOutcomesQuery = {}
): Promise<RollupRow[]> {
  const admin = createAdminClient() as AnyAdmin;
  const since = query.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const until = query.until ?? new Date().toISOString().slice(0, 10);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any).rpc("outcomes_archive_router", {
    p_deployment_id: deploymentId,
    p_since: since,
    p_until: until,
  });

  if (error) throw new Error(`getDeploymentOutcomes: ${error.message}`);

  let rows = (data ?? []) as RollupRow[];
  if (query.metricKeys && query.metricKeys.length > 0) {
    rows = rows.filter((r) => query.metricKeys!.includes(r.metric_key));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// getAgencyOutcomeSummary — aggregates across all active deployments for an agency
// ---------------------------------------------------------------------------

export async function getAgencyOutcomeSummary(
  agencyOrgId: string,
  query: { since?: string; until?: string } = {}
): Promise<OutcomeSummary[]> {
  const admin = createAdminClient() as AnyAdmin;
  const since = query.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const until = query.until ?? new Date().toISOString().slice(0, 10);

  // Get all active deployments for this agency
  const { data: deps } = await admin
    .from("solution_deployments")
    .select("id")
    .eq("agency_org_id", agencyOrgId)
    .in("status", ["active", "pending_setup", "paused"]);

  if (!deps || deps.length === 0) return [];

  const depIds = (deps as { id: string }[]).map((d) => d.id);

  const { data: rows, error } = await admin
    .from("deployment_metrics_rollup")
    .select("metric_key, metric_unit, total_value, deployment_id")
    .in("deployment_id", depIds)
    .gte("date", since)
    .lte("date", until);

  if (error) throw new Error(`getAgencyOutcomeSummary: ${error.message}`);

  return aggregateSummary(rows ?? []);
}

// ---------------------------------------------------------------------------
// getClientOutcomeSummary — aggregates for a client's own deployments
// ---------------------------------------------------------------------------

export async function getClientOutcomeSummary(
  clientOrgId: string,
  query: { since?: string; until?: string } = {}
): Promise<OutcomeSummary[]> {
  const admin = createAdminClient() as AnyAdmin;
  const since = query.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const until = query.until ?? new Date().toISOString().slice(0, 10);

  const { data: deps } = await admin
    .from("solution_deployments")
    .select("id")
    .eq("client_org_id", clientOrgId)
    .in("status", ["active", "pending_setup", "paused"]);

  if (!deps || deps.length === 0) return [];

  const depIds = (deps as { id: string }[]).map((d) => d.id);

  const { data: rows, error } = await admin
    .from("deployment_metrics_rollup")
    .select("metric_key, metric_unit, total_value, deployment_id")
    .in("deployment_id", depIds)
    .gte("date", since)
    .lte("date", until);

  if (error) throw new Error(`getClientOutcomeSummary: ${error.message}`);

  return aggregateSummary(rows ?? []);
}

function aggregateSummary(
  rows: Array<{ metric_key: string; metric_unit: string; total_value: string | number; deployment_id: string }>
): OutcomeSummary[] {
  const byKey = new Map<string, { unit: string; total: number; byDep: Map<string, number> }>();

  for (const row of rows) {
    const v = Number(row.total_value);
    if (!byKey.has(row.metric_key)) {
      byKey.set(row.metric_key, { unit: row.metric_unit, total: 0, byDep: new Map() });
    }
    const entry = byKey.get(row.metric_key)!;
    entry.total += v;
    entry.byDep.set(row.deployment_id, (entry.byDep.get(row.deployment_id) ?? 0) + v);
  }

  return Array.from(byKey.entries()).map(([key, { unit, total, byDep }]) => ({
    metric_key: key,
    metric_unit: unit,
    total_value: total,
    trend_pct: null, // requires prior-period query; deferred to #52/#53 dashboard impl
    per_deployment: Array.from(byDep.entries()).map(([deployment_id, total_value]) => ({
      deployment_id,
      total_value,
    })),
  }));
}

// ---------------------------------------------------------------------------
// getSolutionOutcomeBenchmarks — k≥5 anonymity guard
// Vendor-callable; never exposes per-deployment or per-org data.
// ---------------------------------------------------------------------------

export async function getSolutionOutcomeBenchmarks(
  solutionId: string
): Promise<BenchmarkResponse> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin.rpc("get_solution_outcome_benchmarks", {
    p_solution_id: solutionId,
  });
  if (error) throw new Error(`getSolutionOutcomeBenchmarks: ${error.message}`);

  const rows = data as BenchmarkResult[] | null;
  if (!rows || rows.length === 0) return { insufficient_data: true };
  return { benchmarks: rows };
}

// ---------------------------------------------------------------------------
// outcomesArchiveRouter — stub; always reads hot rollup table.
// Future: route ranges > 24mo to S3 parquet async query.
// ---------------------------------------------------------------------------

export async function outcomesArchiveRouter(
  deploymentId: string,
  since: string, // date string YYYY-MM-DD
  until: string
): Promise<{ rows?: RollupRow[]; jobId?: string; status: "ready" | "queued" }> {
  const rows = await getDeploymentOutcomes(deploymentId, { since, until });
  return { rows, status: "ready" };
}
