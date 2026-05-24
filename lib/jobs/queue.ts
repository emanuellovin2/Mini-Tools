// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { createAdminClient } from "@/lib/services/supabase";

// Job types not yet in generated DB types — cast via any until `npm run types`
// is run after migrations apply.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = ReturnType<typeof createAdminClient> & { from: any; rpc: any };

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "dead";

export interface Job {
  id: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  locked_by: string | null;
  locked_until: string | null;
  last_error: string | null;
  result: unknown;
  org_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface EnqueueOpts {
  idempotencyKey?: string;
  orgId?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueueJob(
  type: string,
  payload: unknown,
  opts: EnqueueOpts = {}
): Promise<{ jobId: string }> {
  const admin = createAdminClient() as AnyClient;
  const { data, error } = await admin
    .from("jobs")
    .insert({
      type,
      payload,
      org_id: opts.orgId ?? null,
      idempotency_key: opts.idempotencyKey ?? null,
      next_run_at: (opts.runAt ?? new Date()).toISOString(),
      max_attempts: opts.maxAttempts ?? 5,
    })
    .select("id")
    .single();
  if (error) {
    // Unique idempotency violation — job already enqueued, return existing
    if ((error as { code?: string }).code === "23505") {
      const { data: existing } = await admin
        .from("jobs")
        .select("id")
        .eq("type", type)
        .eq("idempotency_key", opts.idempotencyKey!)
        .single();
      return { jobId: (existing as { id: string }).id };
    }
    throw new Error(`enqueueJob: ${error.message}`);
  }
  return { jobId: (data as { id: string }).id };
}

// Atomically claims up to `limit` jobs for `workerId`.
// Uses SELECT ... FOR UPDATE SKIP LOCKED — no double-execution under concurrency.
export async function claimJobs(workerId: string, limit = 5): Promise<Job[]> {
  const admin = createAdminClient() as AnyClient;
  const now = new Date().toISOString();
  const leasedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const { data, error } = await admin.rpc("claim_jobs", {
    p_worker_id: workerId,
    p_limit: limit,
    p_now: now,
    p_locked_until: leasedUntil,
  });
  if (error) throw new Error(`claimJobs: ${(error as { message: string }).message}`);
  return (data as Job[]) ?? [];
}

export async function completeJob(jobId: string, result: unknown): Promise<void> {
  const admin = createAdminClient() as AnyClient;
  const { error } = await admin
    .from("jobs")
    .update({
      status: "succeeded",
      result,
      finished_at: new Date().toISOString(),
      locked_by: null,
      locked_until: null,
    })
    .eq("id", jobId);
  if (error) throw new Error(`completeJob: ${(error as { message: string }).message}`);
}

export async function failJob(
  jobId: string,
  errorMessage: string,
  retryInMs = 60_000
): Promise<void> {
  const admin = createAdminClient() as AnyClient;
  const { data: job, error: readErr } = await admin
    .from("jobs")
    .select("attempts, max_attempts")
    .eq("id", jobId)
    .single();
  if (readErr) throw new Error(`failJob read: ${(readErr as { message: string }).message}`);

  const row = job as { attempts: number; max_attempts: number } | null;
  const attempts = (row?.attempts ?? 0) + 1;
  const isDead = attempts >= (row?.max_attempts ?? 5);

  const { error } = await admin
    .from("jobs")
    .update({
      status: isDead ? "dead" : "failed",
      attempts,
      last_error: errorMessage,
      next_run_at: isDead
        ? new Date().toISOString()
        : new Date(Date.now() + retryInMs).toISOString(),
      finished_at: isDead ? new Date().toISOString() : null,
      locked_by: null,
      locked_until: null,
    })
    .eq("id", jobId);
  if (error) throw new Error(`failJob update: ${(error as { message: string }).message}`);
}

// Re-enqueue a dead job (admin replay)
export async function replayJob(jobId: string): Promise<void> {
  const admin = createAdminClient() as AnyClient;
  const { error } = await admin
    .from("jobs")
    .update({
      status: "queued",
      attempts: 0,
      last_error: null,
      result: null,
      next_run_at: new Date().toISOString(),
      finished_at: null,
      locked_by: null,
      locked_until: null,
    })
    .eq("id", jobId)
    .eq("status", "dead");
  if (error) throw new Error(`replayJob: ${(error as { message: string }).message}`);
}
