/**
 * POST /api/builder/[workflowId]/publish
 *
 * Publish the current visual graph as an immutable workflow_version snapshot.
 *
 * Protocol:
 *   - Full validateGraph() runs server-side (structural + entitlement checks).
 *   - Publish is IMPOSSIBLE when validation fails.
 *   - Optimistic version lock: client sends base_version (count at load time).
 *     If the current version count != base_version, returns 409 (concurrent edit).
 *   - On success: creates workflow_version row, sets workflow.status='active'.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/services/supabase";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { VisualGraphSchema, validateGraph, toWorkflowGraph } from "@/lib/workflows/graph-schema";
import { writeAuditLog } from "@/lib/services/admin";

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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const graphRaw = body.graph;
  const baseVersion = body.base_version;

  if (typeof baseVersion !== "number") {
    return NextResponse.json({ error: "base_version required" }, { status: 400 });
  }

  const parsed = VisualGraphSchema.safeParse(graphRaw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_graph", details: parsed.error.issues }, { status: 422 });
  }

  const graph = parsed.data;

  if (graph.nodes.length === 0) {
    return NextResponse.json({ error: "cannot publish an empty graph" }, { status: 422 });
  }

  // Verify caller owns this workflow (RLS)
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

  // Full server-side validation (structural + entitlement checks)
  const validation = await validateGraph(graph, { orgId });
  if (!validation.valid) {
    return NextResponse.json({ error: "validation_failed", errors: validation.errors }, { status: 422 });
  }

  const adminClient = createAdminClient() as AnyAdmin;

  // Optimistic version lock
  const { count: currentVersionCount } = await adminClient
    .from("workflow_versions")
    .select("id", { count: "exact", head: true })
    .eq("workflow_id", workflowId);

  if ((currentVersionCount ?? 0) !== baseVersion) {
    return NextResponse.json(
      { error: "version_conflict", message: "Another edit was published since you loaded. Reload and try again." },
      { status: 409 }
    );
  }

  // Convert VisualGraph → WorkflowGraph for snapshot
  const wfGraph = toWorkflowGraph(graph);
  const nextVersion = baseVersion + 1;

  const { data: version, error: vErr } = await adminClient
    .from("workflow_versions")
    .insert({ workflow_id: workflowId, version: nextVersion, graph: wfGraph })
    .select("id, version")
    .single();

  if (vErr) {
    return NextResponse.json({ error: vErr.message }, { status: 500 });
  }

  // Activate workflow if it was in draft
  await adminClient
    .from("workflows")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", workflowId)
    .eq("status", "draft");

  await writeAuditLog({
    actorId: user.id,
    actorRole: "vendor",
    action: "workflow.version_published",
    entityType: "workflow",
    entityId: workflowId,
    actorOrgId: orgId,
    metadata: { version: nextVersion, via: "builder" },
  });

  return NextResponse.json({ ok: true, version_id: (version as { id: string }).id, version: nextVersion });
}
