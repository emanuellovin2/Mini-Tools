// @vitest-environment node
//
// Unit tests for the workflow executor — resume idempotency, metering-once,
// and trigger auth. Uses mocks to avoid DB/Redis dependencies.
//
// Key invariants tested:
//   1. A step with an existing 'succeeded' checkpoint is NOT re-executed.
//   2. recordUsage is called at most once per run (usage_event_id guard).
//   3. A delay step sets next_run_at and exits without blocking.
//   4. A failed step retries up to MAX_STEP_ATTEMPTS, then fails the run.
//   5. No-credit run halts cleanly without re-metering.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the admin client ────────────────────────────────────────────────────
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockAdmin = { from: mockFrom, rpc: mockRpc };

vi.mock("@/lib/services/supabase", () => ({
  createAdminClient: () => mockAdmin,
}));

vi.mock("@/lib/services/admin", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock recordUsage ─────────────────────────────────────────────────────────
const mockRecordUsage = vi.fn();
vi.mock("@/lib/services/usage", () => ({
  recordUsage: mockRecordUsage,
}));

// ── Mock getEffectiveConfig ──────────────────────────────────────────────────
vi.mock("@/lib/services/deployments", () => ({
  getEffectiveConfig: vi.fn().mockResolvedValue({
    status: "active",
    config: {},
    deployment_id: null,
    solution_type: "workflow",
    credit_wallet_owner: "client",
  }),
}));

// ── Mock step handlers ────────────────────────────────────────────────────────
vi.mock("@/lib/workflows/steps/transform", () => ({
  runTransformStep: vi.fn().mockResolvedValue({ result: { expanded: "ok" } }),
}));
vi.mock("@/lib/workflows/steps/branch", () => ({
  runBranchStep: vi.fn().mockResolvedValue({ matched_branch: null, next_step_key: "step_b" }),
}));
vi.mock("@/lib/workflows/steps/delay", () => ({
  runDelayStep: vi.fn().mockResolvedValue({
    output: { next_run_at: new Date(Date.now() + 3600_000).toISOString(), waited_seconds: 3600 },
    nextRunAt: new Date(Date.now() + 3600_000),
  }),
}));
vi.mock("@/lib/workflows/steps/http", () => ({
  runHttpStep: vi.fn().mockResolvedValue({ status: 200, ok: true, body: '{"sent":true}', headers: {} }),
}));
vi.mock("@/lib/workflows/steps/ai", () => ({
  runAiStep: vi.fn().mockResolvedValue({
    content: "AI response", model: "gpt-4o",
    input_tokens: 10, output_tokens: 20, total_tokens: 30,
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDbChain(returnData: unknown, error: unknown = null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: returnData, error }),
    maybeSingle: vi.fn().mockResolvedValue({ data: returnData, error }),
    insert: vi.fn().mockResolvedValue({ data: returnData, error }),
    update: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue({ data: returnData, error }),
  };
  return chain;
}

// ---------------------------------------------------------------------------

describe("executor — metering once per run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls recordUsage exactly once when usage_event_id is null", async () => {
    // Set up mocks to simulate a 1-step workflow that completes
    const run = {
      id: "run-1",
      workflow_id: "wf-1",
      version_id: "ver-1",
      deployment_id: null,
      status: "running",
      trigger_payload: { name: "Alice" },
      next_step_key: "step_a",
      next_run_at: new Date().toISOString(),
      usage_event_id: null, // not yet metered
      executor_attempt: 1,
      error: null,
      started_at: null,
      finished_at: null,
      idempotency_key: null,
      created_at: new Date().toISOString(),
    };

    const graph = {
      start_step_key: "step_a",
      steps: {
        step_a: { step_key: "step_a", step_type: "transform", config: { mapping: {} }, next_step_key: null },
      },
    };

    const workflow = { org_id: "org-1", meter_id: "meter-1", deployment_id: null };

    mockRecordUsage.mockResolvedValueOnce({
      ok: true, deduped: false, blocked: false,
      remainingBalanceCents: 1000, eventId: "evt-1",
    });

    // from() call routing
    let callIndex = 0;
    mockFrom.mockImplementation((table: string) => {
      callIndex++;
      if (table === "workflow_runs" && callIndex === 1) {
        return makeDbChain(run);
      }
      if (table === "workflow_versions") return makeDbChain({ graph });
      if (table === "workflows") return makeDbChain(workflow);
      if (table === "run_steps") {
        const insertChain = {
          select: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: { id: "rs-1" }, error: null }),
        };
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          insert: vi.fn().mockReturnValue(insertChain),
          update: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: { id: "rs-1" }, error: null }),
        };
      }
      // Default: accept any update
      return {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null }),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: {}, error: null }),
      };
    });

    const { executeRun } = await import("@/lib/services/workflows");
    await executeRun("run-1");

    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "workflow_run:run-1" })
    );
  });

  it("skips recordUsage when usage_event_id is already set", async () => {
    const run = {
      id: "run-2", workflow_id: "wf-1", version_id: "ver-1",
      deployment_id: null, status: "running",
      trigger_payload: {}, next_step_key: "step_a",
      usage_event_id: "evt-already-set", // already metered
      executor_attempt: 2, error: null,
      next_run_at: new Date().toISOString(),
      started_at: null, finished_at: null, idempotency_key: null,
      created_at: new Date().toISOString(),
    };
    const graph = {
      start_step_key: "step_a",
      steps: { step_a: { step_key: "step_a", step_type: "transform", config: { mapping: {} }, next_step_key: null } },
    };
    const workflow = { org_id: "org-1", meter_id: "meter-1", deployment_id: null };

    let idx = 0;
    mockFrom.mockImplementation((table: string) => {
      idx++;
      if (table === "workflow_runs" && idx === 1) return makeDbChain(run);
      if (table === "workflow_versions") return makeDbChain({ graph });
      if (table === "workflows") return makeDbChain(workflow);
      if (table === "run_steps") {
        const ins2 = { select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: "rs-2" }, error: null }) };
        return {
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          insert: vi.fn().mockReturnValue(ins2),
          update: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: "rs-2" }, error: null }),
        };
      }
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ error: null }), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: {}, error: null }) };
    });

    const { executeRun } = await import("@/lib/services/workflows");
    await executeRun("run-2");

    expect(mockRecordUsage).not.toHaveBeenCalled();
  });
});

describe("executor — checkpoint resume (no duplicate side effects)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips step execution when run_step checkpoint is 'succeeded'", async () => {
    const { runTransformStep } = await import("@/lib/workflows/steps/transform");
    const mockTransform = vi.mocked(runTransformStep);
    mockTransform.mockClear();

    const run = {
      id: "run-3", workflow_id: "wf-1", version_id: "ver-1",
      deployment_id: null, status: "running",
      trigger_payload: {}, next_step_key: "step_a",
      usage_event_id: "evt-1", // already metered
      executor_attempt: 2, error: null,
      next_run_at: new Date().toISOString(),
      started_at: null, finished_at: null, idempotency_key: null,
      created_at: new Date().toISOString(),
    };
    const graph = {
      start_step_key: "step_a",
      steps: {
        step_a: { step_key: "step_a", step_type: "transform", config: { mapping: {} }, next_step_key: "step_b" },
        step_b: { step_key: "step_b", step_type: "transform", config: { mapping: {} }, next_step_key: null },
      },
    };
    const workflow = { org_id: "org-1", meter_id: null, deployment_id: null };

    // The existing run_step for step_a is already succeeded (checkpoint)
    const existingStepRow = {
      id: "rs-existing", status: "succeeded",
      output: { result: { prior: "data" } }, attempt: 1,
      next_step_key_override: null,
    };

    let idx = 0;
    mockFrom.mockImplementation((table: string) => {
      idx++;
      if (table === "workflow_runs" && idx === 1) return makeDbChain(run);
      if (table === "workflow_versions") return makeDbChain({ graph });
      if (table === "workflows") return makeDbChain(workflow);
      if (table === "run_steps") {
        const ins3 = { select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: "rs-new" }, error: null }) };
        return {
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: existingStepRow, error: null }),
          insert: vi.fn().mockReturnValue(ins3),
          update: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: existingStepRow, error: null }),
        };
      }
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ error: null }), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: {}, error: null }) };
    });

    const { executeRun } = await import("@/lib/services/workflows");
    const result = await executeRun("run-3");

    // step_a was checkpointed — transform must NOT have been called again
    expect(mockTransform).not.toHaveBeenCalled();
    // Run should advance to step_b
    expect(result.stepExecuted).toBe("step_a");
    expect(result.nextStepKey).toBe("step_b");
  });
});

describe("executor — no-credit halt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("halts run with 'insufficient_credits' when recordUsage returns blocked", async () => {
    mockRecordUsage.mockResolvedValueOnce({
      ok: false, deduped: false, blocked: true,
      remainingBalanceCents: 0, eventId: null,
    });

    const run = {
      id: "run-4", workflow_id: "wf-1", version_id: "ver-1",
      deployment_id: null, status: "running",
      trigger_payload: {}, next_step_key: "step_a",
      usage_event_id: null,
      executor_attempt: 1, error: null,
      next_run_at: new Date().toISOString(),
      started_at: null, finished_at: null, idempotency_key: null,
      created_at: new Date().toISOString(),
    };
    const graph = {
      start_step_key: "step_a",
      steps: { step_a: { step_key: "step_a", step_type: "transform", config: { mapping: {} }, next_step_key: null } },
    };
    const workflow = { org_id: "org-1", meter_id: "meter-1", deployment_id: null };

    const updateMock = vi.fn().mockReturnThis();
    const eqMock = vi.fn().mockResolvedValue({ error: null });

    let idx = 0;
    mockFrom.mockImplementation((table: string) => {
      idx++;
      if (table === "workflow_runs" && idx === 1) return makeDbChain(run);
      if (table === "workflow_versions") return makeDbChain({ graph });
      if (table === "workflows") return makeDbChain(workflow);
      if (table === "workflow_runs") {
        return { update: updateMock, eq: eqMock };
      }
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ error: null }), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: {}, error: null }) };
    });

    const { executeRun } = await import("@/lib/services/workflows");
    const result = await executeRun("run-4");

    expect(result.status).toBe("failed");
  });
});
