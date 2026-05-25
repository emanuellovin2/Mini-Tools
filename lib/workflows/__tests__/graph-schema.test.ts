/**
 * Tests for the shared graph validator (#58).
 *
 * validateGraph is async because it does DB entitlement checks. We mock the
 * Supabase admin client to return controlled results for ownership queries.
 *
 * Coverage:
 *  - Structural validation (orphan nodes, missing start, bad edge refs)
 *  - Per-node config shapes (agent cost-guard, branch schema, etc.)
 *  - Cycle detection (unintended cycle rejected; branch loop allowed)
 *  - Optimistic version lock (409 behavior tested at API level via unit mocks)
 *  - Entitlement checks (cross-tenant resource rejection)
 *  - Step count quota
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VisualGraph } from "../graph-schema";

// ---------------------------------------------------------------------------
// Mock Supabase admin client — returns permissive defaults; individual tests
// override specific tables.
// ---------------------------------------------------------------------------

const mockSelect = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnThis(),
  in: vi.fn().mockReturnThis(),
  or: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn().mockResolvedValue({ data: null }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFrom: any = vi.fn(() => ({
  select: mockSelect,
}));

vi.mock("@/lib/services/supabase", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGraph(overrides: Partial<VisualGraph> = {}): VisualGraph {
  return {
    start_node_id: "step1",
    nodes: [
      {
        id: "step1",
        type: "ai",
        position: { x: 0, y: 0 },
        config: { provider: "openai", model: "gpt-4o", user_template: "{{trigger.input}}" },
      },
    ],
    edges: [],
    ...overrides,
  };
}

function agentNode(id = "agent1", overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "agent" as const,
    position: { x: 200, y: 0 },
    config: {
      role: "Researcher",
      model: "gpt-4o",
      max_iterations: 5,
      budget_cents: 100,
      tools: [],
      handoff: "next",
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Import under test (after mocks are defined)
// ---------------------------------------------------------------------------

let validateGraph: typeof import("../graph-schema").validateGraph;

beforeEach(async () => {
  vi.clearAllMocks();

  // Default: org_quotas returns max_workflow_steps = 50
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockFrom.mockImplementation((table: string): any => {
    const selectImpl = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue(
        table === "org_quotas"
          ? { data: { max_workflow_steps: 50 } }
          : { data: null }
      ),
      // For count queries (returns { count: 50 })
    });
    return { select: selectImpl };
  });

  ({ validateGraph } = await import("../graph-schema"));
});

// ---------------------------------------------------------------------------
// Structural tests
// ---------------------------------------------------------------------------

describe("validateGraph — structural", () => {
  it("accepts a minimal valid single-node graph", async () => {
    const result = await validateGraph(makeGraph(), { orgId: "org1" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects when start_node_id does not exist in nodes", async () => {
    const g = makeGraph({ start_node_id: "nonexistent" });
    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("start_node_id"))).toBe(true);
  });

  it("rejects an edge referencing a nonexistent source", async () => {
    const g = makeGraph({
      edges: [{ id: "e1", source: "ghost", target: "step1" }],
    });
    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("ghost"))).toBe(true);
  });

  it("rejects orphan nodes unreachable from start", async () => {
    const g = makeGraph({
      nodes: [
        { id: "step1", type: "ai", position: { x: 0, y: 0 }, config: { provider: "openai", model: "gpt-4o", user_template: "{{t}}" } },
        { id: "orphan", type: "delay", position: { x: 400, y: 0 }, config: { duration_seconds: 60 } },
      ],
      // No edge from step1 → orphan
    });
    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.node_id === "orphan" && e.message.includes("unreachable"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-node config tests
// ---------------------------------------------------------------------------

describe("validateGraph — node configs", () => {
  it("rejects agent node missing budget_cents", async () => {
    const g: VisualGraph = {
      start_node_id: "a1",
      nodes: [agentNode("a1", { budget_cents: undefined })],
      edges: [],
    };
    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.node_id === "a1")).toBe(true);
  });

  it("rejects agent node missing max_iterations", async () => {
    const g: VisualGraph = {
      start_node_id: "a1",
      nodes: [agentNode("a1", { max_iterations: undefined })],
      edges: [],
    };
    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.node_id === "a1")).toBe(true);
  });

  it("accepts valid agent node with all required fields", async () => {
    const g: VisualGraph = {
      start_node_id: "a1",
      nodes: [agentNode("a1")],
      edges: [],
    };
    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(true);
  });

  it("rejects http node with missing url", async () => {
    const g = makeGraph({
      nodes: [
        {
          id: "step1",
          type: "http",
          position: { x: 0, y: 0 },
          config: { method: "POST" }, // missing url
        },
      ],
    });
    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(false);
  });

  it("rejects branch node with no branches", async () => {
    const g = makeGraph({
      nodes: [
        {
          id: "step1",
          type: "branch",
          position: { x: 0, y: 0 },
          config: { branches: [], default_next_step_key: null },
        },
      ],
    });
    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe("validateGraph — cycle detection", () => {
  it("rejects an unintended cycle (plain chain loops back)", async () => {
    const g: VisualGraph = {
      start_node_id: "s1",
      nodes: [
        { id: "s1", type: "ai", position: { x: 0, y: 0 }, config: { provider: "openai", model: "gpt-4o", user_template: "{{t}}" } },
        { id: "s2", type: "delay", position: { x: 0, y: 200 }, config: { duration_seconds: 60 } },
      ],
      edges: [
        { id: "e1", source: "s1", target: "s2" },
        { id: "e2", source: "s2", target: "s1" }, // cycle — NOT marked allows_cycle
      ],
    };
    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("cycle"))).toBe(true);
  });

  it("allows an intentional branch loop (allows_cycle=true)", async () => {
    const g: VisualGraph = {
      start_node_id: "s1",
      nodes: [
        {
          id: "s1",
          type: "branch",
          position: { x: 0, y: 0 },
          config: {
            branches: [{ condition: "trigger.ok == true", next_step_key: "s2" }],
            default_next_step_key: "s1", // loops back
          },
        },
        { id: "s2", type: "delay", position: { x: 0, y: 200 }, config: { duration_seconds: 60 } },
      ],
      edges: [
        { id: "e1", source: "s1", target: "s2" },
        { id: "e2", source: "s1", target: "s1", allows_cycle: true }, // intentional loop
      ],
    };
    const result = await validateGraph(g, { orgId: "org1" });
    // Should not error on cycle (s2 might show unreachable in some scenarios, adjust)
    const cycleErrors = result.errors.filter((e) => e.message.includes("cycle"));
    expect(cycleErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step count quota
// ---------------------------------------------------------------------------

describe("validateGraph — quota", () => {
  it("rejects when node count exceeds max_workflow_steps", async () => {
    // Override quota to 2
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockFrom.mockImplementation((table: string): any => {
      const selectImpl = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue(
          table === "org_quotas"
            ? { data: { max_workflow_steps: 2 } }
            : { data: null }
        ),
      });
      return { select: selectImpl };
    });

    ({ validateGraph } = await import("../graph-schema"));

    const nodes = Array.from({ length: 3 }, (_, i) => ({
      id: `step${i}`,
      type: "delay" as const,
      position: { x: i * 200, y: 0 },
      config: { duration_seconds: 60 },
    }));
    const edges = [
      { id: "e1", source: "step0", target: "step1" },
      { id: "e2", source: "step1", target: "step2" },
    ];
    const g: VisualGraph = { start_node_id: "step0", nodes, edges };

    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("limit"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Entitlement checks
// ---------------------------------------------------------------------------

describe("validateGraph — entitlements", () => {
  it("rejects a graph referencing another org's connector account", async () => {
    // connector_accounts returns empty (not found for this org)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockFrom.mockImplementation((table: string): any => {
      const mockData = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue(
          table === "org_quotas" ? { data: { max_workflow_steps: 50 } } : { data: null }
        ),
      });
      if (table === "connector_accounts") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [] }), // empty = not owned by org
          }),
        };
      }
      return { select: mockData };
    });

    ({ validateGraph } = await import("../graph-schema"));

    const g: VisualGraph = {
      start_node_id: "c1",
      nodes: [
        {
          id: "c1",
          type: "connector",
          position: { x: 0, y: 0 },
          config: { connector_id: "gmail", account_id: "other-org-account-uuid", action: "send_email" },
        },
      ],
      edges: [],
    };
    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("connector_account"))).toBe(true);
  });

  it("rejects a graph referencing another org's knowledge base", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockFrom.mockImplementation((table: string): any => {
      if (table === "knowledge_bases") {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnThis(),
            or: vi.fn().mockResolvedValue({ data: [] }), // empty = not accessible
          }),
        };
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue(
            table === "org_quotas" ? { data: { max_workflow_steps: 50 } } : { data: null }
          ),
        }),
      };
    });

    ({ validateGraph } = await import("../graph-schema"));

    const g: VisualGraph = {
      start_node_id: "ai1",
      nodes: [
        {
          id: "ai1",
          type: "ai",
          position: { x: 0, y: 0 },
          config: {
            provider: "openai",
            model: "gpt-4o",
            user_template: "{{t}}",
            knowledge_base_ids: ["other-org-kb-uuid"],
          },
        },
      ],
      edges: [],
    };
    const result = await validateGraph(g, { orgId: "org1" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("knowledge_base"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toWorkflowGraph / fromWorkflowGraph round-trip
// ---------------------------------------------------------------------------

describe("graph conversion", () => {
  it("round-trips a linear graph", async () => {
    const { toWorkflowGraph, fromWorkflowGraph } = await import("../graph-schema");

    const original: VisualGraph = {
      start_node_id: "s1",
      nodes: [
        { id: "s1", type: "ai", position: { x: 0, y: 0 }, config: { provider: "openai", model: "gpt-4o", user_template: "{{t}}" } },
        { id: "s2", type: "delay", position: { x: 0, y: 140 }, config: { duration_seconds: 60 } },
      ],
      edges: [{ id: "e1", source: "s1", target: "s2" }],
    };

    const wfGraph = toWorkflowGraph(original);
    expect(wfGraph.start_step_key).toBe("s1");
    expect(wfGraph.steps["s1"].next_step_key).toBe("s2");
    expect(wfGraph.steps["s2"].next_step_key).toBeNull();

    const restored = fromWorkflowGraph(wfGraph);
    expect(restored.start_node_id).toBe("s1");
    expect(restored.nodes).toHaveLength(2);
    expect(restored.edges).toHaveLength(1);
  });

  it("strips _ui_* keys from config on conversion", async () => {
    const { toWorkflowGraph } = await import("../graph-schema");

    const g: VisualGraph = {
      start_node_id: "s1",
      nodes: [
        {
          id: "s1",
          type: "ai",
          position: { x: 42, y: 88 },
          config: {
            provider: "openai",
            model: "gpt-4o",
            user_template: "{{t}}",
            _ui_position: { x: 42, y: 88 },
          },
        },
      ],
      edges: [],
    };
    const wfGraph = toWorkflowGraph(g);
    expect(wfGraph.steps["s1"].config._ui_position).toBeUndefined();
  });
});
