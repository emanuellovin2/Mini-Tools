// @vitest-environment node
//
// Extended RLS tests: audit_log admin-only, vendor_billing isolation,
// webhook_events admin-only, and additional anti-poaching checks.
// Requires local Supabase running with seed data (`supabase start`).

import { describe, it, expect } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const canRun = !!(ANON_KEY && SERVICE_KEY);
const describeMaybe = canRun ? describe : describe.skip;

const IDs = {
  VENDOR_A: "00000000-0000-0000-0000-000000000002",
  VENDOR_B: "00000000-0000-0000-0000-000000000003",
  BUYER_1: "00000000-0000-0000-0000-000000000004",
  ADMIN: "00000000-0000-0000-0000-000000000001",
} as const;

function adminClient(): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY!, {
    auth: { persistSession: false },
  });
}

async function signIn(
  email: string,
  password: string
): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(SUPABASE_URL, ANON_KEY!, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn(${email}): ${error.message}`);
  return client;
}

// ── audit_log: admin-only read ────────────────────────────────────────────────

describeMaybe("RLS: audit_log", () => {
  it("vendor cannot read audit_log", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { data, error } = await vendorA.from("audit_log").select("id");
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("buyer cannot read audit_log", async () => {
    const buyer = await signIn("buyer-1@test.com", "password123");
    const { data, error } = await buyer.from("audit_log").select("id");
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("unauthenticated user cannot read audit_log", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY!, {
      auth: { persistSession: false },
    });
    const { data } = await anon.from("audit_log").select("id");
    expect(data ?? []).toHaveLength(0);
  });

  it("admin can read audit_log via service role", async () => {
    const admin = adminClient();
    const { data, error } = await admin.from("audit_log").select("id");
    expect(error).toBeNull();
    // Seed may have 0 entries — just verify no RLS error
    expect(Array.isArray(data)).toBe(true);
  });
});

// ── vendor_billing: cross-vendor isolation ────────────────────────────────────

describeMaybe("RLS: vendor_billing", () => {
  it("vendor can read their own billing rows", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { data, error } = await vendorA
      .from("vendor_billing")
      .select("id, vendor_id");
    expect(error).toBeNull();
    for (const row of data ?? []) {
      expect(row.vendor_id).toBe(IDs.VENDOR_A);
    }
  });

  it("vendor cannot read another vendor's billing rows", async () => {
    const vendorB = await signIn("vendor-b@test.com", "password123");
    const { data } = await vendorB
      .from("vendor_billing")
      .select("id")
      .eq("vendor_id", IDs.VENDOR_A);
    expect(data ?? []).toHaveLength(0);
  });

  it("buyer cannot read vendor_billing at all", async () => {
    const buyer = await signIn("buyer-1@test.com", "password123");
    const { data } = await buyer.from("vendor_billing").select("id");
    expect(data ?? []).toHaveLength(0);
  });
});

// ── webhook_events: admin-only ────────────────────────────────────────────────

describeMaybe("RLS: webhook_events", () => {
  it("vendor cannot read webhook_events", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { data } = await vendorA.from("webhook_events").select("id");
    expect(data ?? []).toHaveLength(0);
  });

  it("buyer cannot read webhook_events", async () => {
    const buyer = await signIn("buyer-1@test.com", "password123");
    const { data } = await buyer.from("webhook_events").select("id");
    expect(data ?? []).toHaveLength(0);
  });
});

// ── vendor_revenue_events: vendor own-only ────────────────────────────────────

describeMaybe("RLS: vendor_revenue_events", () => {
  it("vendor can read their own revenue events", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { data, error } = await vendorA
      .from("vendor_revenue_events")
      .select("id, vendor_id");
    expect(error).toBeNull();
    for (const row of data ?? []) {
      expect(row.vendor_id).toBe(IDs.VENDOR_A);
    }
  });

  it("vendor cannot read another vendor's revenue events", async () => {
    const vendorB = await signIn("vendor-b@test.com", "password123");
    const { data } = await vendorB
      .from("vendor_revenue_events")
      .select("id")
      .eq("vendor_id", IDs.VENDOR_A);
    expect(data ?? []).toHaveLength(0);
  });

  it("buyer cannot read vendor_revenue_events", async () => {
    const buyer = await signIn("buyer-1@test.com", "password123");
    const { data } = await buyer.from("vendor_revenue_events").select("id");
    expect(data ?? []).toHaveLength(0);
  });
});

// ── Anti-poaching: no path from vendor to buyer_id ────────────────────────────

describeMaybe("Anti-poaching: vendor cannot reach buyer PII", () => {
  it("vendor_subscription_stats() has no buyer_id column", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { data, error } = await vendorA.rpc("vendor_subscription_stats");
    expect(error).toBeNull();
    for (const row of data ?? []) {
      expect(Object.keys(row)).not.toContain("buyer_id");
      expect(Object.keys(row)).not.toContain("stripe_customer_id");
    }
  });

  it("vendor cannot query subscriptions directly to get buyer_id", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { data } = await vendorA
      .from("subscriptions")
      .select("buyer_id");
    // RLS returns 0 rows — vendor has no SELECT policy on subscriptions
    expect(data ?? []).toHaveLength(0);
  });

  it("unauthenticated user cannot read subscriptions", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY!, {
      auth: { persistSession: false },
    });
    const { data } = await anon.from("subscriptions").select("id");
    expect(data ?? []).toHaveLength(0);
  });
});

// ── Role escalation: comprehensive ───────────────────────────────────────────

describeMaybe("RLS: role escalation guard — comprehensive", () => {
  it("vendor cannot elevate their role to admin", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { error } = await vendorA
      .from("profiles")
      .update({ role: "admin" as never })
      .eq("id", IDs.VENDOR_A);
    expect(error).not.toBeNull();
  });

  it("vendor cannot set charges_enabled on themselves", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { error } = await vendorA
      .from("profiles")
      .update({ charges_enabled: true })
      .eq("id", IDs.VENDOR_A);
    expect(error).not.toBeNull();
  });

  it("vendor cannot modify another vendor's profile", async () => {
    const vendorB = await signIn("vendor-b@test.com", "password123");
    const { error } = await vendorB
      .from("profiles")
      .update({ display_name: "Hacked" })
      .eq("id", IDs.VENDOR_A);
    // Either error or 0 rows updated — check nothing changed
    const { data } = await adminClient()
      .from("profiles")
      .select("display_name")
      .eq("id", IDs.VENDOR_A)
      .single();
    expect(data?.display_name).not.toBe("Hacked");
  });

  it("buyer cannot change stripe_account_id", async () => {
    const buyer = await signIn("buyer-1@test.com", "password123");
    const { error } = await buyer
      .from("profiles")
      .update({ stripe_account_id: "acct_malicious" })
      .eq("id", IDs.BUYER_1);
    expect(error).not.toBeNull();
  });
});
