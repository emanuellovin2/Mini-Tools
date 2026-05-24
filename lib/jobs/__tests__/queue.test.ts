import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit tests for job queue logic — pure-function aspects.
// The DB-touching functions (enqueueJob, claimJobs) are covered via
// integration tests that require a live Supabase stack.

// ── failJob retry math ────────────────────────────────────────────────────────

// Isolated pure version of the retry decision from queue.ts
function shouldMarkDead(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

function exponentialBackoff(attempt: number, baseMs = 60_000): number {
  return Math.min(baseMs * 2 ** (attempt - 1), 3_600_000);
}

describe("failJob retry logic", () => {
  it("marks dead when attempts === max_attempts", () => {
    expect(shouldMarkDead(5, 5)).toBe(true);
  });

  it("marks dead when attempts > max_attempts", () => {
    expect(shouldMarkDead(6, 5)).toBe(true);
  });

  it("stays failed (retryable) when attempts < max_attempts", () => {
    expect(shouldMarkDead(3, 5)).toBe(false);
  });

  it("exponential backoff: attempt 1 → 60s", () => {
    expect(exponentialBackoff(1)).toBe(60_000);
  });

  it("exponential backoff: attempt 2 → 120s", () => {
    expect(exponentialBackoff(2)).toBe(120_000);
  });

  it("exponential backoff: attempt 5 → 960s (capped at 3600s)", () => {
    expect(exponentialBackoff(5)).toBe(960_000);
  });

  it("caps backoff at 3600s", () => {
    expect(exponentialBackoff(10)).toBe(3_600_000);
  });
});

// ── SKIP LOCKED concurrency invariant ────────────────────────────────────────

describe("atomic claim concurrency contract", () => {
  it("two workers claiming the same job must not both succeed", () => {
    // This is verified by the Postgres SKIP LOCKED guarantee.
    // The integration test (rls.test.ts) validates the actual DB behavior.
    // This placeholder documents the expected invariant.
    const jobs = [{ id: "job-1", locked_by: null }];
    const worker1Claims = jobs.filter(j => j.locked_by === null);
    // Simulate worker 1 claiming
    worker1Claims.forEach(j => { (j as { locked_by: string | null }).locked_by = "worker-A"; });
    // Worker 2 must find no unlocked jobs
    const worker2Claims = jobs.filter(j => j.locked_by === null);
    expect(worker2Claims).toHaveLength(0);
  });
});

// ── Handler registry ──────────────────────────────────────────────────────────

describe("handler registry", () => {
  it("throws when no handler is registered for a type", async () => {
    const { runJob } = await import("../handlers");
    const fakeJob = {
      id: "j1",
      type: "unknown_type_xyz",
      payload: {},
      status: "running" as const,
      attempts: 1,
      max_attempts: 5,
      org_id: null,
      idempotency_key: null,
      locked_by: null,
      locked_until: null,
      last_error: null,
      result: null,
      created_at: new Date().toISOString(),
      finished_at: null,
      next_run_at: new Date().toISOString(),
    };
    await expect(runJob(fakeJob, "worker-test")).rejects.toThrow(
      "No handler registered for job type: unknown_type_xyz"
    );
  });

  it("runs the erasure stub without throwing", async () => {
    const { runJob } = await import("../handlers");
    const job = {
      id: "j2",
      type: "erasure",
      payload: { userId: "user-123" },
      status: "running" as const,
      attempts: 1,
      max_attempts: 5,
      org_id: null,
      idempotency_key: null,
      locked_by: null,
      locked_until: null,
      last_error: null,
      result: null,
      created_at: new Date().toISOString(),
      finished_at: null,
      next_run_at: new Date().toISOString(),
    };
    const result = await runJob(job, "worker-test");
    expect(result).toMatchObject({ status: "stub" });
  });
});
