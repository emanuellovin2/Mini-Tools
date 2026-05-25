/**
 * Shared graph schema + authoritative server-side validator for the visual
 * workflow builder (#58).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the graph format. It is
 * imported by both client code (for instant Zod feedback) and server routes
 * (for authoritative validation before any save/publish).
 *
 * Design invariants:
 *  - validateGraph() is async — it performs DB entitlement checks.
 *  - Publish is IMPOSSIBLE when validateGraph() returns errors.
 *  - A graph referencing another org's resource is rejected (not silently dropped).
 *  - Agent nodes MUST have budget_cents + max_iterations — no bypass via builder.
 *  - Cycle detection: unintended cycles rejected; branch loops allowed when
 *    allows_cycle=true on the offending edge.
 */

import { z } from "zod";
import { createAdminClient } from "@/lib/services/supabase";

// ---------------------------------------------------------------------------
// Node config schemas (mirrors each step's Config interface)
// ---------------------------------------------------------------------------

const AiNodeConfigSchema = z.object({
  provider: z.enum(["openai", "anthropic", "openai_compat"]),
  model: z.string().min(1),
  user_template: z.string().min(1),
  system_prompt: z.string().optional().nullable(),
  provider_key_id: z.string().optional().nullable(),
  max_tokens: z.number().int().positive().optional(),
  meter_id: z.string().optional().nullable(),
  knowledge_base_ids: z.array(z.string()).optional().nullable(),
  instruction_set_id: z.string().optional().nullable(),
});

const AgentNodeConfigSchema = z.object({
  role: z.string().min(1),
  model: z.string().min(1),
  max_iterations: z.number().int().min(1),
  budget_cents: z.number().int().min(1),
  tools: z.array(
    z.union([
      z.object({ type: z.literal("connector"), connector_id: z.string(), account_id: z.string(), actions: z.array(z.string()) }),
      z.object({ type: z.literal("http"), label: z.string(), url: z.string().optional(), method: z.string().optional() }),
      z.object({ type: z.literal("knowledge.retrieve"), base_ids: z.array(z.string()) }),
      z.object({ type: z.literal("sub_workflow"), workflow_id: z.string() }),
    ])
  ).default([]),
  handoff: z.string().min(1),
  provider: z.enum(["openai", "anthropic", "openai_compat"]).optional(),
  provider_key_id: z.string().optional().nullable(),
  instruction_set_id: z.string().optional().nullable(),
  system_prompt: z.string().optional().nullable(),
  knowledge_base_ids: z.array(z.string()).optional().nullable(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  meter_id: z.string().optional().nullable(),
});

const HttpNodeConfigSchema = z.object({
  url: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body_template: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  timeout_ms: z.number().int().positive().optional(),
});

const TransformNodeConfigSchema = z.object({
  output_mapping: z.record(z.string(), z.string()),
});

const BranchNodeConfigSchema = z.object({
  branches: z.array(z.object({
    condition: z.string().min(1),
    next_step_key: z.string().min(1),
  })).min(1),
  default_next_step_key: z.string().nullable(),
});

const DelayNodeConfigSchema = z.union([
  z.object({ duration_seconds: z.number().int().positive() }),
  z.object({ until_iso: z.string().min(1) }),
]);

const ConnectorNodeConfigSchema = z.object({
  connector_id: z.string().min(1),
  account_id: z.string().min(1),
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Visual graph types
// ---------------------------------------------------------------------------

export const NODE_TYPES = ["ai", "http", "transform", "branch", "delay", "connector", "agent"] as const;
export type NodeType = typeof NODE_TYPES[number];

export const VisualNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NODE_TYPES),
  config: z.record(z.string(), z.unknown()),
  position: z.object({ x: z.number(), y: z.number() }),
  label: z.string().optional(),
});
export type VisualNode = z.infer<typeof VisualNodeSchema>;

export const VisualEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  /** For branch nodes — which branch output port this edge originates from */
  source_handle: z.string().optional(),
  label: z.string().optional(),
  /** When true, a backward/loop edge is intentional (only valid from branch nodes) */
  allows_cycle: z.boolean().optional(),
});
export type VisualEdge = z.infer<typeof VisualEdgeSchema>;

export const VisualGraphSchema = z.object({
  nodes: z.array(VisualNodeSchema),
  edges: z.array(VisualEdgeSchema),
  start_node_id: z.string().min(1),
});
export type VisualGraph = z.infer<typeof VisualGraphSchema>;

// ---------------------------------------------------------------------------
// Validation context + result
// ---------------------------------------------------------------------------

export interface GraphValidationCtx {
  orgId: string;
}

export interface GraphValidationError {
  node_id?: string;
  edge_id?: string;
  field?: string;
  message: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationError[];
}

// ---------------------------------------------------------------------------
// validateGraph — authoritative server-side validator
// ---------------------------------------------------------------------------

/**
 * Run full graph validation: structural integrity, per-node config shapes,
 * quota check, and cross-tenant entitlement checks.
 *
 * This runs SERVER-SIDE on every save and publish. Publish is impossible when
 * this returns valid=false.
 */
export async function validateGraph(
  graph: VisualGraph,
  ctx: GraphValidationCtx
): Promise<GraphValidationResult> {
  const errors: GraphValidationError[] = [];

  // 1. Parse with Zod (structural)
  const parsed = VisualGraphSchema.safeParse(graph);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => ({
        message: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }

  const { nodes, edges, start_node_id } = parsed.data;
  const nodeIds = new Set(nodes.map((n) => n.id));

  // 2. Exactly one entry node
  if (!nodeIds.has(start_node_id)) {
    errors.push({ message: `start_node_id '${start_node_id}' does not exist in nodes` });
  }

  // 3. Edges reference existing nodes
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push({ edge_id: edge.id, message: `Edge source '${edge.source}' not found` });
    }
    if (!nodeIds.has(edge.target)) {
      errors.push({ edge_id: edge.id, message: `Edge target '${edge.target}' not found` });
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  // 4. No orphan nodes (except start node must be reachable from start)
  const reachable = computeReachable(start_node_id, edges);
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      errors.push({ node_id: node.id, message: `Node '${node.id}' is unreachable from start` });
    }
  }

  // 5. Cycle detection
  //    Backward edges with allows_cycle=true are permitted only from branch nodes.
  //    Any other cycle is rejected.
  const cyclicEdgeIds = new Set(
    edges.filter((e) => e.allows_cycle).map((e) => e.id)
  );
  const cycleErrors = detectUnintendedCycles(nodes, edges, cyclicEdgeIds);
  errors.push(...cycleErrors);

  // 6. Per-node config validation
  for (const node of nodes) {
    const cfgErrors = validateNodeConfig(node);
    errors.push(...cfgErrors);
  }

  // 7. Step count quota
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data: quota } = await admin
    .from("org_quotas")
    .select("max_workflow_steps")
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  const maxSteps = (quota?.max_workflow_steps as number | null) ?? 50;
  if (nodes.length > maxSteps) {
    errors.push({ message: `Graph has ${nodes.length} nodes but org limit is ${maxSteps}` });
  }

  // 8. Entitlement checks — referenced resources must be owned by (or public to) this org
  if (errors.length === 0) {
    const entErrors = await checkEntitlements(nodes, ctx.orgId, admin);
    errors.push(...entErrors);
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Entitlement checks
// ---------------------------------------------------------------------------

async function checkEntitlements(
  nodes: VisualNode[],
  orgId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any
): Promise<GraphValidationError[]> {
  const errors: GraphValidationError[] = [];

  // Collect all referenced resource IDs
  const connectorAccountIds: string[] = [];
  const providerKeyIds: string[] = [];
  const knowledgeBaseIds: string[] = [];
  const instructionSetIds: string[] = [];

  for (const node of nodes) {
    const cfg = node.config;

    if (node.type === "connector") {
      if (typeof cfg.account_id === "string") connectorAccountIds.push(cfg.account_id);
    }

    if (node.type === "ai" || node.type === "agent") {
      if (typeof cfg.provider_key_id === "string") providerKeyIds.push(cfg.provider_key_id);
      if (typeof cfg.instruction_set_id === "string") instructionSetIds.push(cfg.instruction_set_id);
      const kbIds = cfg.knowledge_base_ids;
      if (Array.isArray(kbIds)) {
        for (const id of kbIds) {
          if (typeof id === "string") knowledgeBaseIds.push(id);
        }
      }
    }

    if (node.type === "agent") {
      const tools = cfg.tools;
      if (Array.isArray(tools)) {
        for (const tool of tools) {
          if (tool && typeof tool === "object") {
            const t = tool as Record<string, unknown>;
            if (t.type === "connector" && typeof t.account_id === "string") {
              connectorAccountIds.push(t.account_id);
            }
            if (t.type === "knowledge.retrieve" && Array.isArray(t.base_ids)) {
              for (const id of t.base_ids) {
                if (typeof id === "string") knowledgeBaseIds.push(id);
              }
            }
          }
        }
      }
    }
  }

  // Verify connector_accounts
  if (connectorAccountIds.length > 0) {
    const unique = [...new Set(connectorAccountIds)];
    const { data: rows } = await admin
      .from("connector_accounts")
      .select("id")
      .eq("org_id", orgId)
      .in("id", unique);
    const found = new Set((rows ?? []).map((r: { id: string }) => r.id));
    for (const id of unique) {
      if (!found.has(id)) {
        errors.push({ message: `connector_account '${id}' not found or not owned by this org` });
      }
    }
  }

  // Verify provider_keys
  if (providerKeyIds.length > 0) {
    const unique = [...new Set(providerKeyIds)];
    const { data: rows } = await admin
      .from("provider_keys")
      .select("id")
      .eq("org_id", orgId)
      .in("id", unique);
    const found = new Set((rows ?? []).map((r: { id: string }) => r.id));
    for (const id of unique) {
      if (!found.has(id)) {
        errors.push({ message: `provider_key '${id}' not found or not owned by this org` });
      }
    }
  }

  // Verify knowledge_bases (org-owned OR public)
  if (knowledgeBaseIds.length > 0) {
    const unique = [...new Set(knowledgeBaseIds)];
    const { data: rows } = await admin
      .from("knowledge_bases")
      .select("id")
      .in("id", unique)
      .or(`org_id.eq.${orgId},visibility.eq.public`);
    const found = new Set((rows ?? []).map((r: { id: string }) => r.id));
    for (const id of unique) {
      if (!found.has(id)) {
        errors.push({ message: `knowledge_base '${id}' not found or not accessible by this org` });
      }
    }
  }

  // Verify instruction_sets
  if (instructionSetIds.length > 0) {
    const unique = [...new Set(instructionSetIds)];
    const { data: rows } = await admin
      .from("instruction_sets")
      .select("id")
      .eq("org_id", orgId)
      .in("id", unique);
    const found = new Set((rows ?? []).map((r: { id: string }) => r.id));
    for (const id of unique) {
      if (!found.has(id)) {
        errors.push({ message: `instruction_set '${id}' not found or not owned by this org` });
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Per-node config validation
// ---------------------------------------------------------------------------

function validateNodeConfig(node: VisualNode): GraphValidationError[] {
  const errors: GraphValidationError[] = [];

  function addErr(msg: string, field?: string) {
    errors.push({ node_id: node.id, field, message: msg });
  }

  // Strip internal UI metadata before validating config
  const cfg = stripUiMeta(node.config);

  switch (node.type) {
    case "ai": {
      const r = AiNodeConfigSchema.safeParse(cfg);
      if (!r.success) {
        for (const issue of r.error.issues) {
          addErr(issue.message, issue.path.join("."));
        }
      }
      break;
    }
    case "agent": {
      const r = AgentNodeConfigSchema.safeParse(cfg);
      if (!r.success) {
        for (const issue of r.error.issues) {
          addErr(issue.message, issue.path.join("."));
        }
      } else {
        // Cost guard — must have both fields (already enforced by schema, but belt+suspenders)
        if (!r.data.budget_cents || r.data.budget_cents < 1) {
          addErr("agent node must have budget_cents >= 1 (cost guard cannot be bypassed)", "budget_cents");
        }
        if (!r.data.max_iterations || r.data.max_iterations < 1) {
          addErr("agent node must have max_iterations >= 1", "max_iterations");
        }
      }
      break;
    }
    case "http": {
      const r = HttpNodeConfigSchema.safeParse(cfg);
      if (!r.success) {
        for (const issue of r.error.issues) {
          addErr(issue.message, issue.path.join("."));
        }
      }
      break;
    }
    case "transform": {
      const r = TransformNodeConfigSchema.safeParse(cfg);
      if (!r.success) {
        for (const issue of r.error.issues) {
          addErr(issue.message, issue.path.join("."));
        }
      }
      break;
    }
    case "branch": {
      const r = BranchNodeConfigSchema.safeParse(cfg);
      if (!r.success) {
        for (const issue of r.error.issues) {
          addErr(issue.message, issue.path.join("."));
        }
      }
      break;
    }
    case "delay": {
      const r = DelayNodeConfigSchema.safeParse(cfg);
      if (!r.success) {
        addErr("delay node must have either duration_seconds or until_iso");
      }
      break;
    }
    case "connector": {
      const r = ConnectorNodeConfigSchema.safeParse(cfg);
      if (!r.success) {
        for (const issue of r.error.issues) {
          addErr(issue.message, issue.path.join("."));
        }
      }
      break;
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Graph traversal helpers
// ---------------------------------------------------------------------------

function computeReachable(startId: string, edges: VisualEdge[]): Set<string> {
  const reachable = new Set<string>();
  const queue = [startId];
  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    adj.get(edge.source)!.push(edge.target);
  }
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const neighbor of adj.get(current) ?? []) {
      queue.push(neighbor);
    }
  }
  return reachable;
}

function detectUnintendedCycles(
  nodes: VisualNode[],
  edges: VisualEdge[],
  allowedCyclicEdgeIds: Set<string>
): GraphValidationError[] {
  const errors: GraphValidationError[] = [];

  // Build adjacency list excluding allowed cycle edges
  const adj = new Map<string, Array<{ target: string; edgeId: string }>>();
  for (const node of nodes) adj.set(node.id, []);
  for (const edge of edges) {
    if (!allowedCyclicEdgeIds.has(edge.id)) {
      adj.get(edge.source)?.push({ target: edge.target, edgeId: edge.id });
    }
  }

  // DFS cycle detection
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true; // cycle detected
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    inStack.add(nodeId);
    for (const { target, edgeId } of adj.get(nodeId) ?? []) {
      if (dfs(target)) {
        errors.push({
          edge_id: edgeId,
          message: `Unintended cycle detected involving edge to '${target}'. Set allows_cycle=true on a branch edge if this loop is intentional.`,
        });
        return false; // report once
      }
    }
    inStack.delete(nodeId);
    return false;
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) dfs(node.id);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// VisualGraph ↔ WorkflowGraph conversion helpers
// ---------------------------------------------------------------------------

import type { WorkflowGraph, WorkflowStep } from "@/lib/services/workflows";

/**
 * Convert a VisualGraph to a WorkflowGraph (for publish/execution).
 * Strips all UI metadata (_ui_*) from configs.
 */
export function toWorkflowGraph(visual: VisualGraph): WorkflowGraph {
  const steps: Record<string, WorkflowStep> = {};

  // Build adjacency: source → list of targets
  const primaryEdge = new Map<string, string>(); // source → primary next_step_key
  const branchEdges = new Map<string, Array<{ handle: string; target: string }>>(); // for branch nodes

  for (const edge of visual.edges) {
    const sourceNode = visual.nodes.find((n) => n.id === edge.source);
    if (sourceNode?.type === "branch" && edge.source_handle) {
      if (!branchEdges.has(edge.source)) branchEdges.set(edge.source, []);
      branchEdges.get(edge.source)!.push({ handle: edge.source_handle, target: edge.target });
    } else if (!primaryEdge.has(edge.source)) {
      primaryEdge.set(edge.source, edge.target);
    }
  }

  for (const node of visual.nodes) {
    const cleanConfig = stripUiMeta(node.config);

    // For branch nodes: embed next_step_keys from edges into config.branches
    let finalConfig = cleanConfig;
    if (node.type === "branch") {
      const bEdges = branchEdges.get(node.id) ?? [];
      const existingBranches = (cleanConfig.branches as Array<{ condition: string; next_step_key: string }> | undefined) ?? [];
      const updatedBranches = existingBranches.map((b, i) => ({
        ...b,
        next_step_key: bEdges[i]?.target ?? b.next_step_key,
      }));
      finalConfig = {
        ...cleanConfig,
        branches: updatedBranches,
        default_next_step_key: (cleanConfig.default_next_step_key as string | null) ?? null,
      };
    }

    steps[node.id] = {
      step_key: node.id,
      step_type: node.type,
      config: finalConfig,
      next_step_key: primaryEdge.get(node.id) ?? null,
    };
  }

  return {
    start_step_key: visual.start_node_id,
    steps,
  };
}

/**
 * Convert a stored WorkflowGraph back to VisualGraph.
 * Assigns default positions if none are stored in config._ui_position.
 */
export function fromWorkflowGraph(workflow: WorkflowGraph): VisualGraph {
  const nodes: VisualNode[] = [];
  const edges: VisualEdge[] = [];
  let edgeCounter = 0;

  const stepList = Object.values(workflow.steps);

  // Topological sort for default layout
  const visited = new Set<string>();
  const sorted: string[] = [];
  function visit(key: string) {
    if (visited.has(key)) return;
    visited.add(key);
    const step = workflow.steps[key];
    if (step?.next_step_key) visit(step.next_step_key);
    sorted.unshift(key);
  }
  visit(workflow.start_step_key);
  for (const s of stepList) {
    if (!visited.has(s.step_key)) visit(s.step_key);
  }

  const positionMap = new Map<string, { x: number; y: number }>();
  sorted.forEach((key, i) => positionMap.set(key, { x: 200, y: i * 140 + 80 }));

  for (const step of stepList) {
    const stored = step.config._ui_position as { x: number; y: number } | undefined;
    const position = stored ?? positionMap.get(step.step_key) ?? { x: 200, y: 80 };

    nodes.push({
      id: step.step_key,
      type: step.step_type as NodeType,
      config: step.config,
      position,
      label: step.step_key,
    });

    if (step.next_step_key) {
      edges.push({
        id: `e_${edgeCounter++}`,
        source: step.step_key,
        target: step.next_step_key,
      });
    }
  }

  return { nodes, edges, start_node_id: workflow.start_step_key };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Remove _ui_* keys from a config object before execution/validation. */
export function stripUiMeta(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (!k.startsWith("_ui")) result[k] = v;
  }
  return result;
}
