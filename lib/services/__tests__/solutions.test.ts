// @vitest-environment node
//
// Tests for #49 — Solutions abstraction
// Covers: Zod type schemas, runtime_config validation, type immutability
// rules (pure), bundle nesting constraint detection, template fork input
// validation, feature flag guard, and semver format enforcement.
//
// DB-level trigger tests live in rls.test.ts (need a running Supabase stack).

import { describe, it, expect } from "vitest";
import {
  SolutionTypeSchema,
  SolutionSaasSchema,
  SolutionAgentSchema,
  SolutionWorkflowSchema,
  SolutionBundleSchema,
  CreateSolutionInputSchema,
  assertSolutionTypeAllowed,
  isNonSaasEnabled,
  AgentRuntimeConfigSchema,
  WorkflowRuntimeConfigSchema,
  BundleRuntimeConfigSchema,
} from "@/lib/types/solutions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Use proper v4 UUIDs (version nibble = 4, variant = 8/9/a/b)
const UUID1 = "00000000-0000-4000-8000-000000000001";
const UUID2 = "00000000-0000-4000-8000-000000000002";
const UUID3 = "00000000-0000-4000-8000-000000000003";
const UUID4 = "00000000-0000-4000-8000-000000000004";
const UUID5 = "00000000-0000-4000-8000-000000000005";

function baseSolution(overrides = {}) {
  return {
    id: UUID1,
    org_id: UUID2,
    vendor_id: UUID3,
    name: "My Solution",
    description: null,
    category: null,
    price_cents: 1000,
    min_price_cents: null,
    currency: "usd",
    auth_url: null,
    logo_url: null,
    screenshot_urls: [],
    status: "approved",
    stripe_product_id: null,
    stripe_price_id: null,
    affiliate_commission_bps: null,
    rating_avg: 0,
    rating_count: 0,
    featured_until: null,
    has_free_trial: false,
    first_verified_at: null,
    solution_version: "1.0.0",
    template_of_id: null as string | null,
    is_template: false,
    tenant_shard_id: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SolutionTypeSchema
// ---------------------------------------------------------------------------

describe("SolutionTypeSchema", () => {
  it("accepts all four valid types", () => {
    for (const t of ["saas", "agent", "workflow", "bundle"] as const) {
      expect(SolutionTypeSchema.parse(t)).toBe(t);
    }
  });

  it("rejects unknown types", () => {
    expect(() => SolutionTypeSchema.parse("plugin")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Per-type schema validation
// ---------------------------------------------------------------------------

describe("SolutionSaasSchema", () => {
  it("accepts a valid SaaS solution", () => {
    const result = SolutionSaasSchema.safeParse(
      baseSolution({ solution_type: "saas", runtime_config: null })
    );
    expect(result.success).toBe(true);
  });

  it("rejects if solution_type is not 'saas'", () => {
    const result = SolutionSaasSchema.safeParse(
      baseSolution({ solution_type: "agent", runtime_config: null })
    );
    expect(result.success).toBe(false);
  });
});

describe("SolutionAgentSchema", () => {
  const validAgentConfig = {
    model: "claude-opus-4-7",
    provider: "anthropic",
  };

  it("accepts a valid agent solution with required runtime_config fields", () => {
    const result = SolutionAgentSchema.safeParse(
      baseSolution({ solution_type: "agent", runtime_config: validAgentConfig })
    );
    expect(result.success).toBe(true);
  });

  it("rejects agent with missing model", () => {
    const { model: _, ...noModel } = validAgentConfig;
    const result = AgentRuntimeConfigSchema.safeParse(noModel);
    expect(result.success).toBe(false);
  });

  it("rejects invalid provider", () => {
    const result = AgentRuntimeConfigSchema.safeParse({
      model: "gpt-4",
      provider: "mystery-provider",
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional temperature in range [0, 2]", () => {
    expect(
      AgentRuntimeConfigSchema.safeParse({ model: "gpt-4", provider: "openai", temperature: 1.5 }).success
    ).toBe(true);
    expect(
      AgentRuntimeConfigSchema.safeParse({ model: "gpt-4", provider: "openai", temperature: 2.1 }).success
    ).toBe(false);
  });
});

describe("SolutionWorkflowSchema", () => {
  it("accepts a valid workflow with schedule trigger", () => {
    const result = WorkflowRuntimeConfigSchema.safeParse({
      trigger: "schedule",
      schedule_cron: "0 9 * * 1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid trigger type", () => {
    const result = WorkflowRuntimeConfigSchema.safeParse({ trigger: "push" });
    expect(result.success).toBe(false);
  });
});

describe("SolutionBundleSchema", () => {
  const validBundle = {
    item_solution_ids: [UUID4, UUID5],
  };

  it("accepts a valid bundle runtime_config", () => {
    const result = BundleRuntimeConfigSchema.safeParse(validBundle);
    expect(result.success).toBe(true);
  });

  it("rejects empty item_solution_ids array", () => {
    const result = BundleRuntimeConfigSchema.safeParse({ item_solution_ids: [] });
    expect(result.success).toBe(false);
  });

  it("rejects non-uuid in item_solution_ids", () => {
    const result = BundleRuntimeConfigSchema.safeParse({
      item_solution_ids: ["not-a-uuid"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional discount_bps", () => {
    const result = BundleRuntimeConfigSchema.safeParse({
      ...validBundle,
      discount_bps: 500,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative discount_bps", () => {
    const result = BundleRuntimeConfigSchema.safeParse({
      ...validBundle,
      discount_bps: -1,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CreateSolutionInputSchema
// ---------------------------------------------------------------------------

describe("CreateSolutionInputSchema", () => {
  it("defaults solution_type to saas", () => {
    const result = CreateSolutionInputSchema.parse({
      name: "My App",
      price_cents: 500,
    });
    expect(result.solution_type).toBe("saas");
  });

  it("rejects negative price_cents", () => {
    expect(
      () => CreateSolutionInputSchema.parse({ name: "x", price_cents: -1 })
    ).toThrow();
  });

  it("rejects affiliate_commission_bps out of range", () => {
    expect(
      () =>
        CreateSolutionInputSchema.parse({
          name: "x",
          price_cents: 100,
          affiliate_commission_bps: 100, // below minimum 2000
        })
    ).toThrow();

    expect(
      () =>
        CreateSolutionInputSchema.parse({
          name: "x",
          price_cents: 100,
          affiliate_commission_bps: 9000, // above maximum 8000
        })
    ).toThrow();
  });

  it("accepts affiliate_commission_bps within range", () => {
    const result = CreateSolutionInputSchema.safeParse({
      name: "x",
      price_cents: 100,
      affiliate_commission_bps: 3000,
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Semver validation
// ---------------------------------------------------------------------------

describe("semver format", () => {
  const schema = SolutionSaasSchema.shape.solution_version;

  it("accepts valid semver strings", () => {
    for (const v of ["1.0.0", "0.0.1", "12.34.56"]) {
      expect(schema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects invalid formats", () => {
    for (const v of ["1.0", "v1.0.0", "1.0.0-beta", "1.0.0.0", "abc"]) {
      expect(schema.safeParse(v).success, `expected ${v} to fail`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Feature flag guard
// ---------------------------------------------------------------------------

describe("assertSolutionTypeAllowed", () => {
  it("always allows saas", () => {
    expect(() => assertSolutionTypeAllowed("saas")).not.toThrow();
  });

  it("throws for agent/workflow/bundle when flag is off (default)", () => {
    // isNonSaasEnabled reads env — in test env the flag is not set
    if (!isNonSaasEnabled()) {
      for (const type of ["agent", "workflow", "bundle"] as const) {
        expect(() => assertSolutionTypeAllowed(type)).toThrow(/not yet enabled/);
      }
    } else {
      // Flag is on — all types should pass
      for (const type of ["agent", "workflow", "bundle"] as const) {
        expect(() => assertSolutionTypeAllowed(type)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Bundle nesting — pure logic (DB trigger mirrors this)
// ---------------------------------------------------------------------------

describe("bundle nesting guard (pure logic)", () => {
  function wouldNest(
    newType: string,
    templateType: string | null
  ): boolean {
    return newType === "bundle" && templateType === "bundle";
  }

  it("allows bundle forking a non-bundle template", () => {
    expect(wouldNest("bundle", "agent")).toBe(false);
    expect(wouldNest("bundle", "workflow")).toBe(false);
    expect(wouldNest("bundle", null)).toBe(false);
  });

  it("detects nested bundle (bundle forking a bundle)", () => {
    expect(wouldNest("bundle", "bundle")).toBe(true);
  });

  it("non-bundle types are never nested regardless of template", () => {
    expect(wouldNest("agent", "bundle")).toBe(false);
    expect(wouldNest("saas", "bundle")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Semver ordering — pure logic (DB trigger mirrors this)
// ---------------------------------------------------------------------------

describe("semver downgrade guard (pure logic)", () => {
  function parseSemver(v: string): [number, number, number] {
    const [a, b, c] = v.split(".").map(Number);
    return [a, b, c];
  }

  function isDowngrade(oldVer: string, newVer: string): boolean {
    const [om, omi, op] = parseSemver(oldVer);
    const [nm, nmi, np] = parseSemver(newVer);
    return nm < om || (nm === om && nmi < omi) || (nm === om && nmi === omi && np < op);
  }

  it("allows same version (idempotent)", () => {
    expect(isDowngrade("1.2.3", "1.2.3")).toBe(false);
  });

  it("allows patch bump", () => {
    expect(isDowngrade("1.0.0", "1.0.1")).toBe(false);
  });

  it("allows minor bump", () => {
    expect(isDowngrade("1.0.0", "1.1.0")).toBe(false);
  });

  it("allows major bump", () => {
    expect(isDowngrade("1.0.0", "2.0.0")).toBe(false);
  });

  it("detects patch downgrade", () => {
    expect(isDowngrade("1.0.5", "1.0.4")).toBe(true);
  });

  it("detects minor downgrade", () => {
    expect(isDowngrade("1.3.0", "1.2.9")).toBe(true);
  });

  it("detects major downgrade", () => {
    expect(isDowngrade("2.0.0", "1.9.9")).toBe(true);
  });
});
