/**
 * POST /api/builder/[workflowId]/draft
 *
 * Save the current visual graph as a draft (overwrites workflow_steps).
 * Runs server-side validateGraph before writing — rejects on structural
 * errors or entitlement violations.
 *
 * Does NOT create a workflow_version snapshot (that's /publish).
 * Last-writer-wins for draft state (no optimistic lock on saves, only on publish).
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/services/supabase";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { VisualGraphSchema, validateGraph, toWorkflowGraph, stripUiMeta } from "@/lib/workflows/graph-schema";
import { enforceQuota } from "@/lib/quotas/enforce";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  if (process.env.BUILDER_ENABLED !== "true") {
    return NextResponse.json({ error: "builder_disabled" }, { status: 404 });
  }

  const { workflowId } = await params;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = VisualGraphSchema.safeParse((body as Record<string, unknown>)?.graph);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_graph", details: parsed.error.issues }, { status: 422 });
  }

  const graph = parsed.data;

  // Verify caller owns this workflow
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userAdmin = supabase as AnyAdmin;
  const { data: wf, error: wfErr } = await userAdmin
    .from("workflows")
    .select("id, org_id")
    .eq("id", workflowId)
    .single();

  if (wfErr || !wf) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const orgId = wf.org_id as string;

  // Server-side validation (structural only for drafts — entitlements checked on publish)
  const validation = await validateGraph(graph, { orgId });
  if (!validation.valid) {
    return NextResponse.json({ error: "validation_failed", errors: validation.errors }, { status: 422 });
  }

  // Upsert steps via admin client (bypasses RLS for bulk write)
  const adminClient = createAdminClient() as AnyAdmin;

  // Delete existing steps for this workflow
  await adminClient.from("workflow_steps").delete().eq("workflow_id", workflowId);

  // Insert new steps from graph
  if (graph.nodes.length > 0) {
    // Convert VisualGraph to determine next_step_keys
    const wfGraph = toWorkflowGraph(graph);

    const stepRows = graph.nodes.map((node, i) => {
      const step = wfGraph.steps[node.id];
      // Store UI position inside config so it round-trips without schema change
      const configWithUi = { ...stripUiMeta(node.config), _ui_position: node.position };
      return {
        workflow_id: workflowId,
        org_id: orgId,
        step_key: node.id,
        step_type: node.type,
        config: configWithUi,
        position: i,
        next_step_key: step?.next_step_key ?? null,
      };
    });

    // Enforce quota for each step
    for (const _ of stepRows) {
      await enforceQuota(orgId, "workflow_steps");
    }

    const { error: insertErr } = await adminClient
      .from("workflow_steps")
      .insert(stepRows);

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }
  }

  // Touch updated_at on workflow
  await adminClient
    .from("workflows")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", workflowId);

  return NextResponse.json({ ok: true });
}
