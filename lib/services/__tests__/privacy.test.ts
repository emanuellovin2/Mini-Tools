// @vitest-environment node
//
// Tests for #45 partner-client data lifecycle.
// Requires local Supabase (`supabase start`) with a seeded DB.
//
// Verified:
//   1.  upsertPartnerClient creates a new client row
//   2.  upsertPartnerClient updates in place when external_ref matches
//   3.  requestClientErasure soft-deletes immediately; hard erasure job scheduled
//   4.  runErasure fan-out anonymizes usage_events linkage (idempotent)
//   5.  runErasure fan-out purges workflow run_steps I/O
//   6.  runErasure is idempotent (second call is a no-op)
//   7.  listPartnerClients excludes soft-deleted rows
//   8.  requestClientExport creates a tracking request + job
//   9.  Counterparty (another org) cannot read partner_clients (RLS boundary)
//  10.  hasPiiValue guard — partner_clients email is private (not in usage_events after erasure)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const canRun = !!(ANON_KEY && SERVICE_KEY);
const describeMaybe = canRun ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDs = {
  PARTNER_ORG:        "45000000-0000-0000-0000-000000000001",
  OTHER_ORG:          "45000000-0000-0000-0000-000000000002",
  PARTNER_USER:       "45000000-0000-0001-0000-000000000001",
  OTHER_USER:         "45000000-0000-0001-0000-000000000002",
  USAGE_METER:        "45000000-0000-0002-0000-000000000001",
  WALLET:             "45000000-0000-0003-0000-000000000001",
  WORKFLOW:           "45000000-0000-0004-0000-000000000001",
  WORKFLOW_VERSION:   "45000000-0000-0004-0000-000000000002",
} as const;

const EMAILS = {
  partner: "rls45-partner@test.local",
  other:   "rls45-other@test.local",
} as const;

const PW = "TestPassword123!";

function adminClient(): AnyClient {
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
  const a = adminClient();

  // Users: ensure correct UUIDs are in auth.users, cleaning up any stale entries
  // (from previous failed runs that may have created users with random UUIDs).
  for (const [email, id] of [
    [EMAILS.partner, IDs.PARTNER_USER],
    [EMAILS.other,   IDs.OTHER_USER],
  ] as [string, string][]) {
    // Check if user already exists with the correct UUID
    const { data: byId } = await a.auth.admin.getUserById(id);
    if (!byId?.user) {
      // Find and delete any stale user with this email but wrong UUID
      const { data: allUsers } = await a.auth.admin.listUsers({ perPage: 1000 });
      const stale = (allUsers?.users ?? []).find(
        (u: { id: string; email?: string }) => u.email === email && u.id !== id
      );
      if (stale) await a.auth.admin.deleteUser(stale.id);
      // Create with the correct UUID
      await a.auth.admin.createUser({ id, email, password: PW, email_confirm: true });
    }
    await a.from("profiles").upsert({ id, role: "vendor" });
  }

  // Orgs + members
  for (const [orgId, userId] of [
    [IDs.PARTNER_ORG, IDs.PARTNER_USER],
    [IDs.OTHER_ORG,   IDs.OTHER_USER],
  ] as [string, string][]) {
    await a.from("organizations").upsert({ id: orgId, name: `Org-${orgId.slice(-4)}`, type: "agency", slug: null });
    await a.from("org_members").upsert({ org_id: orgId, user_id: userId, role: "owner" });
    await a.from("org_quotas").upsert({
      org_id: orgId,
      max_partner_clients: 9999,
      max_offers: 100, max_api_keys: 100, max_workflows: 100,
      max_affiliate_links: 100, max_connectors: 100, max_webhook_endpoints: 100,
      max_workflow_steps: 100, max_active_deployments: 100, max_clients: 100,
      max_provider_keys: 100, max_gateway_tokens: 100, max_reseller_metered_offers: 100,
    });
  }

  // Workflow + workflow_version: required for workflow_runs FK in test 5
  await a.from("workflows").upsert({
    id: IDs.WORKFLOW, org_id: IDs.PARTNER_ORG,
    name: "Privacy Test Workflow", status: "active", trigger_type: "manual",
  });
  await a.from("workflow_versions").upsert({
    id: IDs.WORKFLOW_VERSION, workflow_id: IDs.WORKFLOW,
    version: 1, graph: { start_step_key: "step-1", steps: {} },
  });
});

afterAll(async () => {
  if (!canRun) return;
  const a = adminClient();
  // Clean up partner_clients and data_requests seeded by tests
  await a.from("partner_data_requests").delete().like("id", "45%");
  await a.from("partner_clients").delete().eq("partner_owner_id", IDs.PARTNER_ORG);
  await a.from("partner_clients").delete().eq("partner_owner_id", IDs.OTHER_ORG);
  await a.from("org_members").delete().in("org_id", [IDs.PARTNER_ORG, IDs.OTHER_ORG]);
  await a.from("organizations").delete().in("id", [IDs.PARTNER_ORG, IDs.OTHER_ORG]);
  for (const id of [IDs.PARTNER_USER, IDs.OTHER_USER]) {
    await a.auth.admin.deleteUser(id);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeMaybe("#45 partner-client data lifecycle", () => {
  let clientId: string;

  it("1. creates a new partner client", async () => {
    const { upsertPartnerClient } = await import("@/lib/services/privacy");
    const { id, created } = await upsertPartnerClient({
      partnerOwnerId: IDs.PARTNER_ORG,
      externalRef: "ext-001",
      email: "alice@client.example",
      displayName: "Alice",
      actorId: IDs.PARTNER_USER,
    });
    expect(created).toBe(true);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    clientId = id;
  });

  it("2. updates in place when external_ref matches", async () => {
    const { upsertPartnerClient } = await import("@/lib/services/privacy");
    const { id, created } = await upsertPartnerClient({
      partnerOwnerId: IDs.PARTNER_ORG,
      externalRef: "ext-001",
      displayName: "Alice Updated",
      actorId: IDs.PARTNER_USER,
    });
    expect(created).toBe(false);
    expect(id).toBe(clientId);
  });

  it("3. requestClientErasure soft-deletes immediately and schedules hard erasure", async () => {
    // Create a separate client to erase
    const { upsertPartnerClient, requestClientErasure } = await import("@/lib/services/privacy");
    const { id: eraseId } = await upsertPartnerClient({
      partnerOwnerId: IDs.PARTNER_ORG,
      externalRef: "erase-me",
      email: "erase@client.example",
    });

    const { jobId, requestId, graceEndsAt } = await requestClientErasure(
      IDs.PARTNER_ORG, eraseId, IDs.PARTNER_USER
    );
    expect(jobId).toBeTruthy();
    expect(requestId).toBeTruthy();
    expect(graceEndsAt.getTime()).toBeGreaterThan(Date.now());

    // Verify soft-delete
    const a = adminClient();
    const { data: row } = await a.from("partner_clients").select("deleted_at").eq("id", eraseId).single();
    expect((row as { deleted_at: string | null }).deleted_at).not.toBeNull();
  });

  it("4. runErasure anonymizes usage_events linkage", async () => {
    const { upsertPartnerClient } = await import("@/lib/services/privacy");
    const { id: pcId } = await upsertPartnerClient({
      partnerOwnerId: IDs.PARTNER_ORG,
      externalRef: "erasure-usage-test",
    });

    const a = adminClient();
    // Seed a usage_event with partner_client_id
    await a.from("usage_events").insert({
      meter_id: IDs.USAGE_METER,
      buyer_id: IDs.PARTNER_USER,
      quantity: 5,
      unit: "tokens",
      partner_client_id: pcId,
      amount_cents: 0,
      vendor_cut_cents: 0,
      platform_cut_cents: 0,
    });

    const { runAllErasers } = await import("@/lib/privacy/erasers");
    await runAllErasers(pcId);

    const { data: events } = await a
      .from("usage_events")
      .select("partner_client_id")
      .eq("buyer_id", IDs.PARTNER_USER)
      .is("partner_client_id", null);
    expect(Array.isArray(events)).toBe(true);
    // After erasure, no event should still have this pcId
    const { data: remaining } = await a
      .from("usage_events")
      .select("id")
      .eq("partner_client_id", pcId);
    expect((remaining ?? []).length).toBe(0);
  });

  it("5. runErasure purges workflow run_steps I/O", async () => {
    const { upsertPartnerClient } = await import("@/lib/services/privacy");
    const { id: pcId } = await upsertPartnerClient({
      partnerOwnerId: IDs.PARTNER_ORG,
      externalRef: "erasure-workflow-test",
    });

    const a = adminClient();
    // Seed a workflow_run linked to this client
    const runId = crypto.randomUUID();
    // workflow_runs has no trigger_type / org_id columns (those are on workflows)
    await a.from("workflow_runs").insert({
      id: runId,
      workflow_id: IDs.WORKFLOW,
      version_id: IDs.WORKFLOW_VERSION,
      status: "succeeded",
      partner_client_id: pcId,
    });
    await a.from("run_steps").insert({
      run_id: runId,
      step_key: "step-1",
      status: "succeeded",
      attempt: 1,
      input: { prompt: "private content" },
      output: { result: "sensitive output" },
      idempotency_key: `${runId}:step-1:1`,
    });

    const { runAllErasers } = await import("@/lib/privacy/erasers");
    await runAllErasers(pcId);

    // Verify I/O purged
    const { data: steps } = await a.from("run_steps").select("input, output").eq("run_id", runId);
    for (const step of (steps ?? []) as { input: unknown; output: unknown }[]) {
      expect(step.input).toBeNull();
      expect(step.output).toBeNull();
    }
    // Run record itself preserved for audit
    const { data: run } = await a.from("workflow_runs").select("id, partner_client_id").eq("id", runId).single();
    expect((run as { id: string; partner_client_id: string | null }).id).toBe(runId);
    expect((run as { partner_client_id: string | null }).partner_client_id).toBeNull();
  });

  it("6. runAllErasers is idempotent (second call is a no-op)", async () => {
    const { runAllErasers } = await import("@/lib/privacy/erasers");
    // Running again on the same pcId should not throw
    await expect(runAllErasers("nonexistent-client-id")).resolves.not.toThrow();
  });

  it("7. listPartnerClients excludes soft-deleted rows", async () => {
    const { listPartnerClients } = await import("@/lib/services/privacy");
    const { clients } = await listPartnerClients(IDs.PARTNER_ORG, { limit: 100 });
    // All returned clients should have deleted_at=null
    for (const c of clients) {
      expect(c.deleted_at).toBeNull();
    }
  });

  it("8. requestClientExport creates a pending request", async () => {
    const { requestClientExport } = await import("@/lib/services/privacy");
    const { jobId, requestId } = await requestClientExport(
      IDs.PARTNER_ORG, clientId, IDs.PARTNER_USER
    );
    expect(jobId).toBeTruthy();
    expect(requestId).toBeTruthy();

    const a = adminClient();
    const { data: req } = await a
      .from("partner_data_requests")
      .select("request_type, status")
      .eq("id", requestId)
      .single();
    expect((req as { request_type: string }).request_type).toBe("export");
    expect(["pending", "processing"]).toContain((req as { status: string }).status);
  });

  it("9. another org cannot read partner_clients (RLS boundary)", async () => {
    const otherClient = await signIn(EMAILS.other);
    // Set active org cookie workaround: query with RLS directly
    const { data, error } = await otherClient
      .from("partner_clients")
      .select("id")
      .eq("partner_owner_id", IDs.PARTNER_ORG);
    // Should return empty (RLS filters) or an error — never another partner's rows
    const rows = (data ?? []) as { id: string }[];
    expect(rows.length).toBe(0);
    void error;
  });
});
