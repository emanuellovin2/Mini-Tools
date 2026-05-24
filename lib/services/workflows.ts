/**
 * Workflow engine service layer (#42).
 *
 * Key invariants:
 * - Executor is tick-driven: one step (or small bounded slice) per invocation.
 *   A `delay` step and long-running steps do NOT block a serverless function.
 * - run_steps rows are the durable checkpoint: a crashed executor resumes from
 *   the last incomplete step with no duplicate side effects.
 * - recordUsage() called exactly once per run (on first slice) via usage_event_id guard.
 * - AI steps meter separately per call; orchestration meters once per run.
 * - Config read ONLY via getEffectiveConfig() per #50/#41 requirement.
 */

import { nanoid } from "nanoid";
import { createAdminClient } from "@/lib/services/supabase";
import { enforceQuota } from "@/lib/quotas/enforce";
import { writeAuditLog } from "@/lib/services/admin";
import { recordUsage } from "@/lib/services/usage";
import { getEffectiveConfig } from "@/lib/services/deployments";
import { runTransformStep, type TransformConfig } from "@/lib/workflows/steps/transform";
import { runBranchStep, type BranchConfig } from "@/lib/workflows/steps/branch";
import { runDelayStep, type DelayConfig } from "@/lib/workflows/steps/delay";
import { runHttpStep, type HttpConfig } from "@/lib/workflows/steps/http";
import { runAiStep, type AiConfig } from "@/lib/workflows/steps/ai";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkflowStatus = "draft" | "active" | "paused";
export type TriggerType = "manual" | "schedule" | "webhook";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type StepType = "ai" | "http" | "transform" | "branch" | "delay" | "connector";

export interface WorkflowStep {
  step_key: string;
  step_type: StepType;
  config: Record<string, unknown>;
  next_step_key: string | null;
  /** For branch steps: ordered list of { condition, next_step_key } */
  branches?: Array<{ condition: string; next_step_key: string }>;
  default_next_step_key?: string | null;
}

export interface WorkflowGraph {
  start_step_key: string;
  steps: Record<string, WorkflowStep>;
}

export interface Workflow {
  id: string;
  org_id: string;
  deployment_id: string | null;
  name: string;
  status: WorkflowStatus;
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown>;
  meter_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowVersion {
  id: string;
  workflow_id: string;
  version: number;
  graph: WorkflowGraph;
  is_template: boolean;
  template_of_id: string | null;
  created_at: string;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  version_id: string;
  deployment_id: string | null;
  status: RunStatus;
  trigger_payload: Record<string, unknown> | null;
  next_step_key: string | null;
  next_run_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  usage_event_id: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export interface RunStep {
  id: string;
  run_id: string;
  step_key: string;
  step_type: string;
  status: StepStatus;
  input: unknown;
  output: unknown;
  attempt: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const MAX_STEP_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Workflow CRUD
// ---------------------------------------------------------------------------

export async function createWorkflow(args: {
  orgId: string;
  name: string;
  triggerType?: TriggerType;
  triggerConfig?: Record<string, unknown>;
  deploymentId?: string | null;
  meterId?: string | null;
  actorUserId: string;
  actorOrgId: string;
}): Promise<Workflow> {
  await enforceQuota(args.orgId, "workflows");

  const admin = createAdminClient() as AnyAdmin;

  // Generate webhook secret for webhook-type triggers
  const webhookSecret =
    args.triggerType === "webhook" ? `whs_${nanoid(32)}` : null;

  const { data, error } = await admin
    .from("workflows")
    .insert({
      org_id: args.orgId,
      name: args.name,
      trigger_type: args.triggerType ?? "manual",
      trigger_config: args.triggerConfig ?? {},
      deployment_id: args.deploymentId ?? null,
      meter_id: args.meterId ?? null,
      webhook_secret: webhookSecret,
    })
    .select("id, org_id, deployment_id, name, status, trigger_type, trigger_config, meter_id, created_at, updated_at")
    .single();

  if (error) throw new Error(`createWorkflow: ${error.message}`);

  await writeAuditLog({
    actorId: args.actorUserId,
    actorRole: "vendor",
    action: "workflow.created",
    entityType: "workflow",
    entityId: data.id,
    actorOrgId: args.actorOrgId,
    metadata: { name: args.name, trigger_type: args.triggerType },
  });

  return data as Workflow;
}

export async function addWorkflowStep(args: {
  workflowId: string;
  orgId: string;
  stepKey: string;
  stepType: StepType;
  config: Record<string, unknown>;
  position?: number;
  nextStepKey?: string | null;
}): Promise<void> {
  await enforceQuota(args.orgId, "workflow_steps");

  const admin = createAdminClient() as AnyAdmin;
  const { error } = await admin.from("workflow_steps").insert({
    workflow_id: args.workflowId,
    org_id: args.orgId,
    step_key: args.stepKey,
    step_type: args.stepType,
    config: args.config,
    position: args.position ?? 0,
    next_step_key: args.nextStepKey ?? null,
  });
  if (error) throw new Error(`addWorkflowStep: ${error.message}`);
}

/**
 * Snapshot the current editable steps into an immutable version.
 * Returns the new version row.
 */
export async function publishVersion(
  workflowId: string,
  orgId: string,
  actorUserId: string,
  actorOrgId: string
): Promise<WorkflowVersion> {
  const admin = createAdminClient() as AnyAdmin;

  // Load workflow + steps
  const { data: wf, error: wfErr } = await admin
    .from("workflows")
    .select("id, org_id, trigger_type")
    .eq("id", workflowId)
    .eq("org_id", orgId)
    .single();
  if (wfErr || !wf) throw new Error(`publishVersion: workflow ${workflowId} not found`);

  const { data: steps, error: stepsErr } = await admin
    .from("workflow_steps")
    .select("step_key, step_type, config, next_step_key, position")
    .eq("workflow_id", workflowId)
    .order("position", { ascending: true });
  if (stepsErr) throw new Error(`publishVersion: ${stepsErr.message}`);

  if (!steps || steps.length === 0) {
    throw new Error("publishVersion: workflow has no steps");
  }

  // Build graph
  const stepsMap: Record<string, WorkflowStep> = {};
  for (const s of steps) {
    stepsMap[s.step_key] = {
      step_key: s.step_key,
      step_type: s.step_type,
      config: s.config,
      next_step_key: s.next_step_key,
    };
  }

  const graph: WorkflowGraph = {
    start_step_key: (steps[0] as { step_key: string }).step_key,
    steps: stepsMap,
  };

  // Get next version number
  const { count } = await admin
    .from("workflow_versions")
    .select("id", { count: "exact", head: true })
    .eq("workflow_id", workflowId);

  const nextVersion = ((count as number | null) ?? 0) + 1;

  const { data: version, error: vErr } = await admin
    .from("workflow_versions")
    .insert({ workflow_id: workflowId, version: nextVersion, graph })
    .select()
    .single();
  if (vErr) throw new Error(`publishVersion: ${vErr.message}`);

  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "vendor",
    action: "workflow.version_published",
    entityType: "workflow",
    entityId: workflowId,
    actorOrgId,
    metadata: { version: nextVersion },
  });

  return version as WorkflowVersion;
}

export async function setStatus(
  workflowId: string,
  orgId: string,
  status: WorkflowStatus,
  actorUserId: string,
  actorOrgId: string
): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { error } = await admin
    .from("workflows")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", workflowId)
    .eq("org_id", orgId);
  if (error) throw new Error(`setStatus: ${error.message}`);

  await writeAuditLog({
    actorId: actorUserId,
    actorRole: "vendor",
    action: "workflow.status_changed",
    entityType: "workflow",
    entityId: workflowId,
    actorOrgId,
    metadata: { status },
  });
}

// ---------------------------------------------------------------------------
// Run management
// ---------------------------------------------------------------------------

/**
 * Enqueue a workflow run. Manual trigger uses next_run_at = now()
 * (same tick path — no separate synchronous executor).
 */
export async function enqueueRun(
  workflowId: string,
  payload: Record<string, unknown>,
  idempotencyKey?: string
): Promise<{ runId: string }> {
  const admin = createAdminClient() as AnyAdmin;

  // Verify workflow is active and fetch latest version
  const { data: wf, error: wfErr } = await admin
    .from("workflows")
    .select("id, org_id, status, meter_id")
    .eq("id", workflowId)
    .single();
  if (wfErr || !wf) throw new Error(`enqueueRun: workflow ${workflowId} not found`);
  if (wf.status !== "active") throw new Error(`enqueueRun: workflow is not active (status=${wf.status})`);

  // Get latest published version
  const { data: latestVersion, error: vErr } = await admin
    .from("workflow_versions")
    .select("id, graph")
    .eq("workflow_id", workflowId)
    .order("version", { ascending: false })
    .limit(1)
    .single();
  if (vErr || !latestVersion) {
    throw new Error(`enqueueRun: no published version found for workflow ${workflowId}`);
  }

  const graph = latestVersion.graph as WorkflowGraph;

  const { data: run, error: runErr } = await admin
    .from("workflow_runs")
    .insert({
      workflow_id: workflowId,
      version_id: latestVersion.id,
      trigger_payload: payload,
      next_step_key: graph.start_step_key,
      next_run_at: new Date().toISOString(),
      idempotency_key: idempotencyKey ?? null,
    })
    .select("id")
    .single();

  if (runErr) {
    if ((runErr as { code?: string }).code === "23505") {
      // Idempotency dedup — return existing run id
      const { data: existing } = await admin
        .from("workflow_runs")
        .select("id")
        .eq("idempotency_key", idempotencyKey!)
        .single();
      return { runId: (existing as { id: string }).id };
    }
    throw new Error(`enqueueRun: ${runErr.message}`);
  }

  return { runId: (run as { id: string }).id };
}

// ---------------------------------------------------------------------------
// Executor — tick-driven durable state machine
// ---------------------------------------------------------------------------

/**
 * Execute one slice of a workflow run.
 * Called by the `workflow_execute` job handler; runs one step per invocation.
 * The cron tick re-claims the run for the next step after this returns.
 *
 * Idempotent: re-executing a completed step reads the checkpoint and advances
 * without re-running the side-effecting logic.
 */
export async function executeRun(runId: string): Promise<{
  status: RunStatus;
  stepExecuted: string | null;
  nextStepKey: string | null;
}> {
  const admin = createAdminClient() as AnyAdmin;

  // 1. Load the run (already claimed by cron; re-read current state)
  const { data: run, error: runErr } = await admin
    .from("workflow_runs")
    .select("*")
    .eq("id", runId)
    .single();
  if (runErr || !run) throw new Error(`executeRun: run ${runId} not found`);

  const r = run as WorkflowRun & {
    executor_attempt: number;
    org_id?: string;
    meter_id?: string;
  };

  if (r.status === "succeeded" || r.status === "failed" || r.status === "canceled") {
    return { status: r.status, stepExecuted: null, nextStepKey: null };
  }

  // 2. Load version graph
  const { data: ver, error: verErr } = await admin
    .from("workflow_versions")
    .select("graph")
    .eq("id", r.version_id)
    .single();
  if (verErr || !ver) throw new Error(`executeRun: version ${r.version_id} not found`);

  const graph = ver.graph as WorkflowGraph;

  // 3. Meter exactly once per run (idempotent via usage_event_id guard)
  if (!r.usage_event_id) {
    // Fetch meter_id from the workflow row
    const { data: wf } = await admin
      .from("workflows")
      .select("meter_id, org_id, deployment_id")
      .eq("id", r.workflow_id)
      .single();

    if (wf?.meter_id) {
      // Determine buyer_id: deployment's client_org_id or fall back to org_id
      let buyerId = wf.org_id as string;
      if (wf.deployment_id) {
        const { data: dep } = await admin
          .from("solution_deployments")
          .select("client_org_id")
          .eq("id", wf.deployment_id)
          .single();
        if (dep?.client_org_id) buyerId = dep.client_org_id as string;
      }

      const usageResult = await recordUsage({
        meterId: wf.meter_id as string,
        buyerId,
        quantity: 1,
        idempotencyKey: `workflow_run:${runId}`,
        actorOrgId: wf.org_id as string,
      });

      if (usageResult.blocked) {
        // No credits — halt run cleanly, checkpoint partial work preserved
        await admin
          .from("workflow_runs")
          .update({ status: "failed", error: "insufficient_credits", finished_at: new Date().toISOString() })
          .eq("id", runId);
        return { status: "failed", stepExecuted: null, nextStepKey: null };
      }

      // Save usage_event_id so we never double-charge on retry
      await admin
        .from("workflow_runs")
        .update({ usage_event_id: usageResult.eventId })
        .eq("id", runId);
    }
  }

  // 4. Find current step
  const currentStepKey = r.next_step_key;
  if (!currentStepKey) {
    // No next step — run is already complete (shouldn't normally reach here)
    await admin
      .from("workflow_runs")
      .update({ status: "succeeded", finished_at: new Date().toISOString() })
      .eq("id", runId);
    return { status: "succeeded", stepExecuted: null, nextStepKey: null };
  }

  const stepDef = graph.steps[currentStepKey];
  if (!stepDef) {
    const errMsg = `unknown step key: ${currentStepKey}`;
    await admin
      .from("workflow_runs")
      .update({ status: "failed", error: errMsg, finished_at: new Date().toISOString() })
      .eq("id", runId);
    return { status: "failed", stepExecuted: currentStepKey, nextStepKey: null };
  }

  // 5. Check for existing checkpoint (resume idempotently on crash)
  const { data: existingStep } = await admin
    .from("run_steps")
    .select("id, status, output, attempt, next_step_key_override")
    .eq("run_id", runId)
    .eq("step_key", currentStepKey)
    .order("attempt", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingStep?.status === "succeeded") {
    // Already succeeded — advance without re-executing (no duplicate side effects)
    const nextKey = (existingStep.next_step_key_override as string | null) ?? stepDef.next_step_key ?? null;
    await advanceRun(admin, runId, nextKey, r.workflow_id);
    return { status: "running", stepExecuted: currentStepKey, nextStepKey: nextKey };
  }

  const attempt = (existingStep?.attempt ?? 0) + 1;
  const stepIdempotencyKey = `${runId}:${currentStepKey}:${attempt}`;

  // 6. Collect execution context (trigger payload + all prior succeeded steps' outputs)
  const context = await buildRunContext(admin, runId, r.trigger_payload ?? {});

  // 7. Insert run_step row for this attempt
  const { data: stepRow } = await admin
    .from("run_steps")
    .insert({
      run_id: runId,
      step_key: currentStepKey,
      step_type: stepDef.step_type,
      status: "running",
      input: context,
      attempt,
      idempotency_key: stepIdempotencyKey,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  const stepRowId = (stepRow as { id: string } | null)?.id;

  // 8. Execute the step
  let output: unknown;
  let nextStepKeyOverride: string | null = null;
  let delayedNextRunAt: Date | null = null;

  try {
    const result = await dispatchStep(stepDef, context, r, admin);
    output = result.output;
    nextStepKeyOverride = result.nextStepKeyOverride ?? null;
    delayedNextRunAt = result.nextRunAt ?? null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Mark step failed
    if (stepRowId) {
      await admin.from("run_steps").update({
        status: "failed",
        error: errMsg,
        finished_at: new Date().toISOString(),
      }).eq("id", stepRowId);
    }

    if (attempt >= MAX_STEP_ATTEMPTS) {
      // Step exhausted retries — fail the run (partial work is checkpointed)
      await admin.from("workflow_runs").update({
        status: "failed",
        error: `Step '${currentStepKey}' failed after ${attempt} attempt(s): ${errMsg}`,
        finished_at: new Date().toISOString(),
      }).eq("id", runId);
      return { status: "failed", stepExecuted: currentStepKey, nextStepKey: null };
    }

    // Schedule retry (exponential back-off: 30s, 60s, 120s…)
    const retryDelayMs = 30_000 * Math.pow(2, attempt - 1);
    await admin.from("workflow_runs").update({
      next_run_at: new Date(Date.now() + retryDelayMs).toISOString(),
      status: "running",
    }).eq("id", runId);

    return { status: "running", stepExecuted: currentStepKey, nextStepKey: currentStepKey };
  }

  // 9. Checkpoint success
  if (stepRowId) {
    await admin.from("run_steps").update({
      status: "succeeded",
      output,
      finished_at: new Date().toISOString(),
    }).eq("id", stepRowId);
  }

  // 10. Advance or delay
  if (delayedNextRunAt) {
    // Delay step: stay in running, schedule next_run_at in the future
    const nextKey = nextStepKeyOverride ?? stepDef.next_step_key ?? null;
    await admin.from("workflow_runs").update({
      next_step_key: nextKey,
      next_run_at: delayedNextRunAt.toISOString(),
      status: "running",
    }).eq("id", runId);
    return { status: "running", stepExecuted: currentStepKey, nextStepKey: nextKey };
  }

  const nextKey = nextStepKeyOverride ?? stepDef.next_step_key ?? null;
  await advanceRun(admin, runId, nextKey, r.workflow_id);

  return {
    status: nextKey ? "running" : "succeeded",
    stepExecuted: currentStepKey,
    nextStepKey: nextKey,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function advanceRun(
  admin: AnyAdmin,
  runId: string,
  nextStepKey: string | null,
  _workflowId: string
): Promise<void> {
  if (nextStepKey) {
    // More steps — re-queue immediately
    await admin.from("workflow_runs").update({
      next_step_key: nextStepKey,
      next_run_at: new Date().toISOString(),
      status: "running",
    }).eq("id", runId);
  } else {
    // Terminal — run succeeded
    await admin.from("workflow_runs").update({
      next_step_key: null,
      status: "succeeded",
      finished_at: new Date().toISOString(),
    }).eq("id", runId);
  }
}

async function buildRunContext(
  admin: AnyAdmin,
  runId: string,
  triggerPayload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = { trigger: triggerPayload };

  // Collect all succeeded step outputs, keyed by step_key
  const { data: succeededSteps } = await admin
    .from("run_steps")
    .select("step_key, output")
    .eq("run_id", runId)
    .eq("status", "succeeded");

  for (const s of succeededSteps ?? []) {
    context[s.step_key as string] = s.output;
  }

  return context;
}

interface DispatchResult {
  output: unknown;
  nextStepKeyOverride?: string | null;
  nextRunAt?: Date | null;
}

async function dispatchStep(
  stepDef: WorkflowStep,
  context: Record<string, unknown>,
  run: WorkflowRun & { org_id?: string },
  admin: AnyAdmin
): Promise<DispatchResult> {
  switch (stepDef.step_type) {
    case "transform": {
      const result = await runTransformStep(
        stepDef.config as unknown as TransformConfig,
        { context }
      );
      return { output: result };
    }

    case "branch": {
      const result = await runBranchStep(
        stepDef.config as unknown as BranchConfig,
        { context }
      );
      return { output: result, nextStepKeyOverride: result.next_step_key };
    }

    case "delay": {
      const result = await runDelayStep(stepDef.config as unknown as DelayConfig);
      return { output: result.output, nextRunAt: result.nextRunAt };
    }

    case "http": {
      const result = await runHttpStep(
        stepDef.config as unknown as HttpConfig,
        { context }
      );
      return { output: result };
    }

    case "ai": {
      // Resolve deployment-level provider key from effective config
      let deploymentProviderKeyId: string | null = null;
      const deploymentId = run.deployment_id;
      if (deploymentId) {
        const effectiveCfg = await getEffectiveConfig(deploymentId);
        const cfg = effectiveCfg.config;
        deploymentProviderKeyId =
          (cfg.byok_provider_key_id as string | null) ??
          (cfg.agency_provider_key_id as string | null) ??
          null;
      }

      // Determine buyer_id and owner_org_id
      const { data: wf } = await admin
        .from("workflows")
        .select("org_id, deployment_id")
        .eq("id", run.workflow_id)
        .single();
      const orgId = (wf?.org_id ?? run.org_id ?? "") as string;
      let buyerId = orgId;
      if (wf?.deployment_id) {
        const { data: dep } = await admin
          .from("solution_deployments")
          .select("client_org_id")
          .eq("id", wf.deployment_id)
          .single();
        if (dep?.client_org_id) buyerId = dep.client_org_id as string;
      }

      const result = await runAiStep(stepDef.config as unknown as AiConfig, {
        context,
        deploymentProviderKeyId,
        ownerOrgId: orgId,
        buyerId,
        runId: run.id,
        stepKey: stepDef.step_key,
      });
      return { output: result };
    }

    case "connector": {
      // Connector steps light up after #43 — stub for now
      console.log(
        JSON.stringify({ event: "workflow.connector_step.stub", step_key: stepDef.step_key })
      );
      return { output: { status: "stub", message: "Connector support available after #43" } };
    }

    default: {
      throw new Error(`executeRun: unknown step type: ${(stepDef as { step_type: string }).step_type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

export async function getRunHistory(
  workflowId: string,
  opts: { limit?: number; before?: string } = {}
): Promise<Array<WorkflowRun & { steps: RunStep[] }>> {
  const admin = createAdminClient() as AnyAdmin;
  const limit = opts.limit ?? 20;

  let q = admin
    .from("workflow_runs")
    .select("*")
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (opts.before) {
    q = q.lt("created_at", opts.before);
  }

  const { data: runs, error } = await q;
  if (error) throw new Error(`getRunHistory: ${error.message}`);

  // Fetch steps for each run
  const result: Array<WorkflowRun & { steps: RunStep[] }> = [];
  for (const run of runs ?? []) {
    const { data: steps } = await admin
      .from("run_steps")
      .select("*")
      .eq("run_id", run.id)
      .order("started_at", { ascending: true });
    result.push({ ...(run as WorkflowRun), steps: (steps ?? []) as RunStep[] });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Template install — clone a published template version into a new workflow
// ---------------------------------------------------------------------------

export async function installTemplate(args: {
  buyerOrgId: string;
  templateVersionId: string;
  name?: string;
  actorUserId: string;
  actorOrgId: string;
}): Promise<{ workflowId: string }> {
  const admin = createAdminClient() as AnyAdmin;

  // Load template version
  const { data: templateVer, error: tvErr } = await admin
    .from("workflow_versions")
    .select("id, workflow_id, version, graph")
    .eq("id", args.templateVersionId)
    .eq("is_template", true)
    .single();
  if (tvErr || !templateVer) {
    throw new Error(`installTemplate: template version ${args.templateVersionId} not found`);
  }

  const sourceGraph = templateVer.graph as WorkflowGraph;

  // Load source workflow for metadata
  const { data: srcWf } = await admin
    .from("workflows")
    .select("name, trigger_type, trigger_config")
    .eq("id", templateVer.workflow_id)
    .single();

  // Create the buyer's workflow (status='draft' — buyer must activate)
  await enforceQuota(args.buyerOrgId, "workflows");

  const newName = args.name ?? (srcWf?.name ? `${srcWf.name} (installed)` : "Installed Workflow");
  const { data: newWf, error: wfErr } = await admin
    .from("workflows")
    .insert({
      org_id: args.buyerOrgId,
      name: newName,
      trigger_type: srcWf?.trigger_type ?? "manual",
      trigger_config: srcWf?.trigger_config ?? {},
      // Do NOT copy meter_id or keys — buyer supplies their own
    })
    .select("id")
    .single();
  if (wfErr || !newWf) throw new Error(`installTemplate: ${wfErr?.message}`);

  // Clone the graph into editable workflow_steps
  const steps = Object.values(sourceGraph.steps);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await enforceQuota(args.buyerOrgId, "workflow_steps");
    await admin.from("workflow_steps").insert({
      workflow_id: (newWf as { id: string }).id,
      org_id: args.buyerOrgId,
      step_key: s.step_key,
      step_type: s.step_type,
      // Scrub provider-specific key IDs — buyer must supply own keys
      config: sanitizeTemplateStepConfig(s.config),
      position: i,
      next_step_key: s.next_step_key,
    });
  }

  // Publish the cloned graph as version 1, marking template_of_id for attribution
  const { data: newVer, error: vErr } = await admin
    .from("workflow_versions")
    .insert({
      workflow_id: (newWf as { id: string }).id,
      version: 1,
      graph: sourceGraph,
      template_of_id: args.templateVersionId,
    })
    .select("id")
    .single();
  if (vErr) throw new Error(`installTemplate: ${vErr.message}`);

  await writeAuditLog({
    actorId: args.actorUserId,
    actorRole: "buyer",
    action: "workflow.template_installed",
    entityType: "workflow",
    entityId: (newWf as { id: string }).id,
    actorOrgId: args.actorOrgId,
    metadata: {
      template_version_id: args.templateVersionId,
      source_workflow_id: templateVer.workflow_id,
    },
  });

  void newVer; // version created for future runs

  return { workflowId: (newWf as { id: string }).id };
}

/** Strip provider key IDs from step config when installing a template. */
function sanitizeTemplateStepConfig(config: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...config };
  delete sanitized.provider_key_id;
  return sanitized;
}

// ---------------------------------------------------------------------------
// Schedule trigger — enqueue runs for due schedule-triggered workflows
// ---------------------------------------------------------------------------

export async function enqueueScheduledRuns(): Promise<{ enqueued: number }> {
  const admin = createAdminClient() as AnyAdmin;

  // Fetch all active schedule-triggered workflows
  const { data: workflows, error } = await admin
    .from("workflows")
    .select("id, trigger_config, org_id")
    .eq("status", "active")
    .eq("trigger_type", "schedule");

  if (error) throw new Error(`enqueueScheduledRuns: ${error.message}`);

  let enqueued = 0;
  const now = new Date();

  for (const wf of workflows ?? []) {
    const cfg = wf.trigger_config as { cron?: string; next_run_iso?: string } | null;
    if (!cfg) continue;

    // Simple "next_run_iso" config: run at the specified time (one-shot or repeated via external update)
    if (cfg.next_run_iso) {
      const nextRun = new Date(cfg.next_run_iso);
      if (nextRun <= now) {
        await enqueueRun(wf.id as string, { triggered_by: "schedule" },
          `schedule:${wf.id}:${now.toISOString().slice(0, 16)}`
        ).catch(() => {}); // idempotency key deduplicates concurrent runs
        enqueued++;
      }
    }
  }

  return { enqueued };
}
