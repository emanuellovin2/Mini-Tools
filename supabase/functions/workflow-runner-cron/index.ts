// Supabase Edge Function — workflow run scheduler + executor tick
// Schedule: * * * * *  (every minute)
//
// Two jobs per invocation:
//   1. Schedule trigger: enqueue runs for due schedule-triggered workflows.
//   2. Run executor: claim up to CLAIM_LIMIT due workflow_runs and enqueue
//      `workflow_execute` jobs for each (one step per job execution).
//
// The executor is tick-driven: each `workflow_execute` job advances one step.
// The next tick re-claims the run for the next step. This ensures zero
// long-running invocations even for 100-step workflows or delay steps.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLAIM_LIMIT = 10; // runs to process per tick

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  const results: string[] = [];
  const now = new Date().toISOString();

  // ── 1. Schedule trigger: enqueue due schedule-triggered workflows ───────────
  try {
    const { data: schedWfs } = await supabase
      .from("workflows")
      .select("id, trigger_config")
      .eq("status", "active")
      .eq("trigger_type", "schedule");

    for (const wf of schedWfs ?? []) {
      const cfg = wf.trigger_config as { next_run_iso?: string } | null;
      if (cfg?.next_run_iso && cfg.next_run_iso <= now) {
        const idempotencyKey = `schedule:${wf.id}:${now.slice(0, 16)}`;
        const { error } = await supabase.from("workflow_runs").insert({
          workflow_id: wf.id,
          // Get latest version inline
          version_id: await getLatestVersionId(supabase, wf.id),
          trigger_payload: { triggered_by: "schedule", scheduled_at: now },
          next_run_at: now,
          idempotency_key: idempotencyKey,
        });

        if (error && (error as { code?: string }).code !== "23505") {
          console.error(JSON.stringify({ event: "workflow_runner.schedule_enqueue_error", wf_id: wf.id, error: error.message }));
        } else {
          results.push(`sched:${wf.id}`);
        }
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "workflow_runner.schedule_phase_error", error: String(err) }));
  }

  // ── 2. Run executor: claim due runs and enqueue workflow_execute jobs ───────
  let claimed = 0;
  for (let i = 0; i < CLAIM_LIMIT; i++) {
    const { data: run, error: claimErr } = await supabase
      .rpc("claim_workflow_run", { p_worker_id: `cron-${now}` })
      .maybeSingle();

    if (claimErr) {
      console.error(JSON.stringify({ event: "workflow_runner.claim_error", error: claimErr.message }));
      break;
    }
    if (!run) break; // No more due runs

    // Enqueue a workflow_execute job for this run
    const { error: jobErr } = await supabase.from("jobs").insert({
      type: "workflow_execute",
      payload: { runId: (run as { id: string }).id },
      org_id: null,
      idempotency_key: `wf_execute:${(run as { id: string }).id}:${now.slice(0, 16)}`,
      max_attempts: 3,
    });

    if (jobErr && (jobErr as { code?: string }).code !== "23505") {
      console.error(JSON.stringify({ event: "workflow_runner.job_enqueue_error", run_id: (run as { id: string }).id, error: jobErr.message }));
    } else {
      claimed++;
      results.push(`exec:${(run as { id: string }).id}`);
    }
  }

  console.log(JSON.stringify({ event: "workflow_runner.tick", scheduled: results.filter(r => r.startsWith("sched:")).length, claimed }));

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "Content-Type": "application/json" },
  });
});

async function getLatestVersionId(supabase: ReturnType<typeof createClient>, workflowId: string): Promise<string | null> {
  const { data } = await supabase
    .from("workflow_versions")
    .select("id")
    .eq("workflow_id", workflowId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? (data as { id: string }).id : null;
}
