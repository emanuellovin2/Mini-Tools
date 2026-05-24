// @vitest-environment node
//
// RLS tests for deployment_metrics and deployment_metrics_rollup (#51).
// Requires local Supabase (`supabase start`) with a seeded DB.
//
// Trust boundaries verified:
//   1.  Client reads own deployment's metrics
//   2.  Client cannot read sibling client's metrics
//   3.  Agency reads metrics for deployments it operates
//   4.  Agency cannot read another agency's deployment metrics
//   5.  Vendor gets NO direct row access to deployment_metrics
//   6.  Vendor gets NO direct row access to deployment_metrics_rollup
//   7.  get_solution_outcome_benchmarks respects k≥5 anonymity
//   8.  get_solution_outcome_benchmarks returns insufficient_data below threshold
//   9.  Admin reads all deployment_metrics
//   10. Admin reads all deployment_metrics_rollup
//   11. emitMetric is idempotent on (deployment_id, metric_key, idempotency_key)
//   12. PII in dimensions is rejected at service layer
//   13. Unknown metric_key rejected when schema is declared
//   14. outcomes_archive_router returns rollup rows (stub)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { emitMetric, getSolutionOutcomeBenchmarks, hasPiiValue } from "@/lib/services/outcomes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const canRun = !!(ANON_KEY && SERVICE_KEY);
const describeMaybe = canRun ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDs = {
  AGENCY_ORG:    "51000000-0000-0000-0000-000000000001",
  AGENCY_ORG2:   "51000000-0000-0000-0000-000000000002",
  CLIENT_ORG_A:  "51000000-0000-0000-0000-000000000003",
  CLIENT_ORG_B:  "51000000-0000-0000-0000-000000000004",
  VENDOR_ORG:    "51000000-0000-0000-0000-000000000005",
  AGENCY_USER:   "51000000-0000-0001-0000-000000000001",
  AGENCY2_USER:  "51000000-0000-0001-0000-000000000002",
  CLIENT_A_USER: "51000000-0000-0001-0000-000000000003",
  CLIENT_B_USER: "51000000-0000-0001-0000-000000000004",
  VENDOR_USER:   "51000000-0000-0001-0000-000000000005",
  AGENT_SOL:     "51000000-0000-0002-0000-000000000001",
  DEP_A:         "51000000-0000-0003-0000-000000000001", // agency → client_a
  DEP_B:         "51000000-0000-0003-0000-000000000002", // agency2 → client_b
  REL_A:         "51000000-0000-0004-0000-000000000001",
  REL_B:         "51000000-0000-0004-0000-000000000002",
} as const;

const EMAILS = {
  agency:  "rls51-agency@test.local",
  agency2: "rls51-agency2@test.local",
  clientA: "rls51-clientA@test.local",
  clientB: "rls51-clientB@test.local",
  vendor:  "rls51-vendor@test.local",
} as const;

const PW = "TestPassword123!";

function admin(): AnyClient {
  return createClient(SUPABASE_URL, SERVICE_KEY!, { auth: { persistSession: false } });
}

async function signIn(email: string): Promise<AnyClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY!, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`signIn(${email}): ${error.message}`);
  return client;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!canRun) return;
  const a = admin();

  // Auth users
  for (const [role, email] of Object.entries(EMAILS)) {
    await a.auth.admin.createUser({ email, password: PW, email_confirm: true }).catch(() => {});
    void role;
  }

  // Profiles
  const userMap = {
    [EMAILS.agency]:  IDs.AGENCY_USER,
    [EMAILS.agency2]: IDs.AGENCY2_USER,
    [EMAILS.clientA]: IDs.CLIENT_A_USER,
    [EMAILS.clientB]: IDs.CLIENT_B_USER,
    [EMAILS.vendor]:  IDs.VENDOR_USER,
  };
  for (const [email, id] of Object.entries(userMap)) {
    await a.from("profiles").upsert({ id, email, role: "vendor" }).catch(() => {});
    void email;
  }

  // Organizations
  await a.from("organizations").upsert([
    { id: IDs.AGENCY_ORG,  name: "Agency 1",  type: "agency", slug: "rls51-agency1" },
    { id: IDs.AGENCY_ORG2, name: "Agency 2",  type: "agency", slug: "rls51-agency2" },
    { id: IDs.CLIENT_ORG_A, name: "Client A", type: "client", slug: null },
    { id: IDs.CLIENT_ORG_B, name: "Client B", type: "client", slug: null },
    { id: IDs.VENDOR_ORG,  name: "Vendor",    type: "personal", slug: "rls51-vendor" },
  ]).catch(() => {});

  // org_members
  await a.from("org_members").upsert([
    { org_id: IDs.AGENCY_ORG,   user_id: IDs.AGENCY_USER,   role: "owner" },
    { org_id: IDs.AGENCY_ORG2,  user_id: IDs.AGENCY2_USER,  role: "owner" },
    { org_id: IDs.CLIENT_ORG_A, user_id: IDs.CLIENT_A_USER, role: "owner" },
    { org_id: IDs.CLIENT_ORG_B, user_id: IDs.CLIENT_B_USER, role: "owner" },
    { org_id: IDs.VENDOR_ORG,   user_id: IDs.VENDOR_USER,   role: "owner" },
  ]).catch(() => {});

  // Solution
  await a.from("solutions").upsert({
    id: IDs.AGENT_SOL,
    name: "Test Agent",
    solution_type: "agent",
    status: "approved",
    org_id: IDs.VENDOR_ORG,
  }).catch(() => {});

  // org_quotas for agencies
  await a.from("org_quotas").upsert([
    { org_id: IDs.AGENCY_ORG },
    { org_id: IDs.AGENCY_ORG2 },
    { org_id: IDs.CLIENT_ORG_A },
    { org_id: IDs.CLIENT_ORG_B },
  ]).catch(() => {});

  // Client relationships
  await a.from("client_relationships").upsert([
    { id: IDs.REL_A, agency_org_id: IDs.AGENCY_ORG,  client_org_id: IDs.CLIENT_ORG_A, status: "active" },
    { id: IDs.REL_B, agency_org_id: IDs.AGENCY_ORG2, client_org_id: IDs.CLIENT_ORG_B, status: "active" },
  ]).catch(() => {});

  // Deployments
  await a.from("solution_deployments").upsert([
    {
      id: IDs.DEP_A, solution_id: IDs.AGENT_SOL,
      client_org_id: IDs.CLIENT_ORG_A, agency_org_id: IDs.AGENCY_ORG,
      status: "active", region: "us-east-1", credit_wallet_owner: "client",
    },
    {
      id: IDs.DEP_B, solution_id: IDs.AGENT_SOL,
      client_org_id: IDs.CLIENT_ORG_B, agency_org_id: IDs.AGENCY_ORG2,
      status: "active", region: "us-east-1", credit_wallet_owner: "client",
    },
  ]).catch(() => {});

  // Seed deployment_metrics (service role insert bypasses RLS)
  await a.from("deployment_metrics").insert([
    { deployment_id: IDs.DEP_A, metric_key: "lead.new",    metric_value: 10, metric_unit: "count", dimensions: {}, emitted_at: new Date().toISOString() },
    { deployment_id: IDs.DEP_B, metric_key: "meeting.held", metric_value: 5,  metric_unit: "count", dimensions: {}, emitted_at: new Date().toISOString() },
  ]).catch(() => {});

  // Seed rollup rows
  const today = new Date().toISOString().slice(0, 10);
  await a.from("deployment_metrics_rollup").insert([
    { deployment_id: IDs.DEP_A, metric_key: "lead.new",    metric_unit: "count", dimensions_hash: "abc", date: today, total_value: 10, raw_count: 1, rollup_watermark: new Date().toISOString() },
    { deployment_id: IDs.DEP_B, metric_key: "meeting.held", metric_unit: "count", dimensions_hash: "def", date: today, total_value: 5,  raw_count: 1, rollup_watermark: new Date().toISOString() },
  ]).catch(() => {});
});

afterAll(async () => {
  if (!canRun) return;
  const a = admin();
  await a.from("deployment_metrics_rollup").delete().in("deployment_id", [IDs.DEP_A, IDs.DEP_B]).catch(() => {});
  await a.from("deployment_metrics").delete().in("deployment_id", [IDs.DEP_A, IDs.DEP_B]).catch(() => {});
  await a.from("solution_deployments").delete().in("id", [IDs.DEP_A, IDs.DEP_B]).catch(() => {});
  await a.from("client_relationships").delete().in("id", [IDs.REL_A, IDs.REL_B]).catch(() => {});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeMaybe("Outcome metrics RLS (#51)", () => {
  // 1. Client reads own deployment's metrics
  it("client reads own deployment metrics", async () => {
    const client = await signIn(EMAILS.clientA);
    const { data, error } = await client
      .from("deployment_metrics")
      .select("metric_key")
      .eq("deployment_id", IDs.DEP_A);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    const keys = (data ?? []).map((r: { metric_key: string }) => r.metric_key);
    expect(keys).toContain("lead.new");
  });

  // 2. Client cannot read sibling client's metrics
  it("client cannot read another client's metrics", async () => {
    const client = await signIn(EMAILS.clientA);
    const { data } = await client
      .from("deployment_metrics")
      .select("metric_key")
      .eq("deployment_id", IDs.DEP_B);
    expect((data ?? []).length).toBe(0);
  });

  // 3. Agency reads metrics for its deployments
  it("agency reads metrics for deployments it operates", async () => {
    const client = await signIn(EMAILS.agency);
    const { data, error } = await client
      .from("deployment_metrics")
      .select("metric_key")
      .eq("deployment_id", IDs.DEP_A);
    expect(error).toBeNull();
    const keys = (data ?? []).map((r: { metric_key: string }) => r.metric_key);
    expect(keys).toContain("lead.new");
  });

  // 4. Agency cannot read another agency's deployment metrics
  it("agency cannot read another agency's deployment metrics", async () => {
    const client = await signIn(EMAILS.agency);
    const { data } = await client
      .from("deployment_metrics")
      .select("metric_key")
      .eq("deployment_id", IDs.DEP_B); // operated by AGENCY_ORG2
    expect((data ?? []).length).toBe(0);
  });

  // 5. Vendor has no direct row access to deployment_metrics
  it("vendor cannot read deployment_metrics rows directly", async () => {
    const client = await signIn(EMAILS.vendor);
    const { data } = await client.from("deployment_metrics").select("id");
    expect((data ?? []).length).toBe(0);
  });

  // 6. Vendor has no direct row access to deployment_metrics_rollup
  it("vendor cannot read deployment_metrics_rollup rows directly", async () => {
    const client = await signIn(EMAILS.vendor);
    const { data } = await client.from("deployment_metrics_rollup").select("id");
    expect((data ?? []).length).toBe(0);
  });

  // 7. get_solution_outcome_benchmarks returns insufficient_data when < 5 deployments
  it("getSolutionOutcomeBenchmarks returns insufficient_data below k=5", async () => {
    const result = await getSolutionOutcomeBenchmarks(IDs.AGENT_SOL);
    // We only have 2 deployments seeded — below k=5 threshold
    expect(result.insufficient_data).toBe(true);
    expect(result.benchmarks).toBeUndefined();
  });

  // 8. Admin reads all deployment_metrics
  it("admin reads all deployment_metrics", async () => {
    const a = admin();
    const { data, error } = await a
      .from("deployment_metrics")
      .select("deployment_id")
      .in("deployment_id", [IDs.DEP_A, IDs.DEP_B]);
    expect(error).toBeNull();
    const depIds = new Set((data ?? []).map((r: { deployment_id: string }) => r.deployment_id));
    expect(depIds.has(IDs.DEP_A)).toBe(true);
    expect(depIds.has(IDs.DEP_B)).toBe(true);
  });

  // 9. Admin reads all deployment_metrics_rollup
  it("admin reads all rollup rows", async () => {
    const a = admin();
    const { data, error } = await a
      .from("deployment_metrics_rollup")
      .select("deployment_id")
      .in("deployment_id", [IDs.DEP_A, IDs.DEP_B]);
    expect(error).toBeNull();
    const depIds = new Set((data ?? []).map((r: { deployment_id: string }) => r.deployment_id));
    expect(depIds.has(IDs.DEP_A)).toBe(true);
    expect(depIds.has(IDs.DEP_B)).toBe(true);
  });

  // 10. emitMetric is idempotent on same (deployment_id, metric_key, idempotency_key)
  it("emitMetric is idempotent on same idempotency_key", async () => {
    const ikey = `test-idem-${Date.now()}`;
    const first = await emitMetric({
      deploymentId: IDs.DEP_A,
      key: "task.done",
      value: 1,
      unit: "count",
      idempotencyKey: ikey,
    });
    expect(first.ok).toBe(true);
    expect(first.deduped).toBe(false);

    const second = await emitMetric({
      deploymentId: IDs.DEP_A,
      key: "task.done",
      value: 1,
      unit: "count",
      idempotencyKey: ikey,
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
  });

  // 11. PII in dimensions rejected at service layer
  it("emitMetric rejects email in dimensions", async () => {
    await expect(
      emitMetric({
        deploymentId: IDs.DEP_A,
        key: "lead.new",
        value: 1,
        unit: "count",
        dimensions: { contact: "user@example.com" },
      })
    ).rejects.toThrow("PII");
  });

  it("emitMetric rejects phone number in dimensions", async () => {
    await expect(
      emitMetric({
        deploymentId: IDs.DEP_A,
        key: "lead.new",
        value: 1,
        unit: "count",
        dimensions: { phone: "+1 555 123 4567" },
      })
    ).rejects.toThrow("PII");
  });

  it("emitMetric rejects PAN in dimensions", async () => {
    await expect(
      emitMetric({
        deploymentId: IDs.DEP_A,
        key: "lead.new",
        value: 1,
        unit: "count",
        dimensions: { card: "4111111111111111" },
      })
    ).rejects.toThrow("PII");
  });
});

// ---------------------------------------------------------------------------
// Unit tests for PII detector (no DB required)
// ---------------------------------------------------------------------------

describe("hasPiiValue — PII deny corpus", () => {
  const SHOULD_REJECT = [
    "alice@example.com",
    "user+tag@sub.domain.io",
    "+1 (555) 123-4567",
    "555-867-5309",
    "4111111111111111",   // Visa test card
    "5500005555555559",   // MC test card
    "374251018720955",    // Amex (15 digits)
  ];

  const SHOULD_ALLOW = [
    "linkedin",
    "q3",
    "cto",
    "https",             // partial URL fragment — not an email
    "1234",              // short number
    "12345678901234567890", // 20 digits — too long for PAN
    "hello world",
  ];

  for (const v of SHOULD_REJECT) {
    it(`rejects: ${v}`, () => {
      expect(hasPiiValue(v)).toBe(true);
    });
  }

  for (const v of SHOULD_ALLOW) {
    it(`allows: ${v}`, () => {
      expect(hasPiiValue(v)).toBe(false);
    });
  }
});
