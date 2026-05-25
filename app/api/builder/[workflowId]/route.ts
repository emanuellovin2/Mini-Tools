/**
 * GET /api/builder/[workflowId]
 *
 * Load a workflow for the visual builder. Returns the workflow metadata,
 * current draft steps converted to VisualGraph format, and the current
 * published version count (used as the base_version for optimistic locking).
 *
 * Requires authentication and org membership. BUILDER_ENABLED flag gated.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { fromWorkflowGraph } from "@/lib/workflows/graph-schema";
import type { WorkflowGraph, WorkflowStep } from "@/lib/services/workflows";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  if (process.env.BUILDER_ENABLED !== "true") {
    return NextResponse.json({ error: "builder_disabled" }, { status: 404 });
  }

  const { workflowId } = await params;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = supabase as AnyAdmin;

  // Load workflow — RLS ensures org membership
  const { data: wf, error: wfErr } = await admin
    .from("workflows")
    .select("id, org_id, name, status, trigger_type, trigger_config, updated_at")
    .eq("id", workflowId)
    .single();

  if (wfErr || !wf) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Load draft steps
  const { data: steps, error: stepsErr } = await admin
    .from("workflow_steps")
    .select("step_key, step_type, config, next_step_key, position")
    .eq("workflow_id", workflowId)
    .order("position", { ascending: true });

  if (stepsErr) {
    return NextResponse.json({ error: stepsErr.message }, { status: 500 });
  }

  // Get published version count (for optimistic lock)
  const { count: versionCount } = await admin
    .from("workflow_versions")
    .select("id", { count: "exact", head: true })
    .eq("workflow_id", workflowId);

  // Convert steps to VisualGraph
  let visualGraph;
  if (!steps || steps.length === 0) {
    visualGraph = { nodes: [], edges: [], start_node_id: "" };
  } else {
    const stepsMap: Record<string, WorkflowStep> = {};
    for (const s of steps) {
      stepsMap[s.step_key as string] = s as WorkflowStep;
    }
    const wfGraph: WorkflowGraph = {
      start_step_key: (steps[0] as { step_key: string }).step_key,
      steps: stepsMap,
    };
    visualGraph = fromWorkflowGraph(wfGraph);
  }

  return NextResponse.json({
    workflow: wf,
    graph: visualGraph,
    base_version: versionCount ?? 0,
  });
}
