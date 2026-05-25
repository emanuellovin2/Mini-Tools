/**
 * Visual workflow builder page — /builder/[workflowId]
 *
 * Server component that loads workflow + draft steps, then hands off to the
 * client-side WorkflowCanvas. Gated by BUILDER_ENABLED env var.
 */

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { fromWorkflowGraph } from "@/lib/workflows/graph-schema";
import type { WorkflowGraph, WorkflowStep } from "@/lib/services/workflows";
import { WorkflowCanvas } from "@/components/builder/Canvas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

interface BuilderPageProps {
  params: Promise<{ workflowId: string }>;
}

export default async function BuilderPage({ params }: BuilderPageProps) {
  if (process.env.BUILDER_ENABLED !== "true") {
    redirect("/");
  }

  const { workflowId } = await params;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient() as AnyAdmin;

  // Load workflow (RLS applied via user session, but we use admin for flexibility)
  const { data: wf } = await admin
    .from("workflows")
    .select("id, org_id, name, status, trigger_type")
    .eq("id", workflowId)
    .maybeSingle();

  if (!wf) redirect("/");

  // Load draft steps
  const { data: steps } = await admin
    .from("workflow_steps")
    .select("step_key, step_type, config, next_step_key, position")
    .eq("workflow_id", workflowId)
    .order("position", { ascending: true });

  // Get version count for optimistic lock
  const { count: versionCount } = await admin
    .from("workflow_versions")
    .select("id", { count: "exact", head: true })
    .eq("workflow_id", workflowId);

  // Build initial VisualGraph
  let initialGraph;
  if (!steps || steps.length === 0) {
    initialGraph = { nodes: [], edges: [], start_node_id: "" };
  } else {
    const stepsMap: Record<string, WorkflowStep> = {};
    for (const s of steps) {
      stepsMap[s.step_key as string] = s as WorkflowStep;
    }
    const wfGraph: WorkflowGraph = {
      start_step_key: (steps[0] as { step_key: string }).step_key,
      steps: stepsMap,
    };
    initialGraph = fromWorkflowGraph(wfGraph);
  }

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Header */}
      <header className="flex items-center gap-3 px-5 py-3 border-b border-slate-200 bg-white flex-shrink-0">
        <a href="/" className="text-slate-400 hover:text-slate-700 text-sm">← Back</a>
        <span className="text-slate-300">|</span>
        <h1 className="text-sm font-semibold text-slate-800 truncate">{(wf as { name: string }).name}</h1>
        <span className={`ml-1 text-[10px] font-medium px-2 py-0.5 rounded-full ${
          (wf as { status: string }).status === "active"
            ? "bg-emerald-100 text-emerald-700"
            : "bg-slate-100 text-slate-500"
        }`}>
          {(wf as { status: string }).status}
        </span>
      </header>

      {/* Canvas fills remaining height */}
      <div className="flex-1 min-h-0">
        <WorkflowCanvas
          workflowId={workflowId}
          initialGraph={initialGraph}
          baseVersion={versionCount ?? 0}
        />
      </div>
    </div>
  );
}
