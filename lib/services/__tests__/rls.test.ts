// @vitest-environment node
//
// Integration tests for RLS policies.
// Requires local Supabase to be running (`supabase start`) with seed data loaded.
// Set NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in .env.test or
// export them before running: supabase start && npm test

import { describe, it, expect } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Skip the entire suite if env vars are absent (CI without Supabase, type-check-only runs).
const canRun = !!(ANON_KEY && SERVICE_KEY);
const describeMaybe = canRun ? describe : describe.skip;

// Known UUIDs from seed.sql
const IDs = {
  VENDOR_A: "00000000-0000-0000-0000-000000000002",
  VENDOR_B: "00000000-0000-0000-0000-000000000003",
  BUYER_1: "00000000-0000-0000-0000-000000000004",
  BUYER_2: "00000000-0000-0000-0000-000000000005",
  APP_1: "00000000-0000-0000-0001-000000000001",
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

describeMaybe("RLS: apps table", () => {
  it("vendor can read their own apps", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { data, error } = await vendorA
      .from("apps")
      .select("id")
      .eq("vendor_id", IDs.VENDOR_A);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });

  it("vendor cannot read another vendor's apps", async () => {
    const vendorB = await signIn("vendor-b@test.com", "password123");
    const { data } = await vendorB
      .from("apps")
      .select("id")
      .eq("vendor_id", IDs.VENDOR_A);
    expect(data ?? []).toHaveLength(0);
  });

  it("unauthenticated user sees only approved apps with charges_enabled=true", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY!, {
      auth: { persistSession: false },
    });
    const { data, error } = await anon.from("apps").select("id, status, vendor_id");
    expect(error).toBeNull();
    for (const row of data ?? []) {
      expect(row.status).toBe("approved");
      // vendor_b (charges_enabled=false) app must NOT appear
      expect(row.vendor_id).not.toBe(IDs.VENDOR_B);
    }
  });
});

describeMaybe("RLS: subscriptions — anti-poaching boundary", () => {
  it("vendor gets zero rows when querying subscriptions directly", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { data, error } = await vendorA.from("subscriptions").select("*");
    // RLS returns 0 rows (no error, just empty result — PostgREST behavior)
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("vendor_subscription_stats() returns rows for their apps without buyer_id", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { data, error } = await vendorA.rpc("vendor_subscription_stats");
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    const row = data![0];
    expect(row).toHaveProperty("app_id");
    expect(row).toHaveProperty("anon_user_id");
    expect(row).toHaveProperty("status");
    expect(row).toHaveProperty("price_cents");
    expect(row).toHaveProperty("current_period_end");
    expect(row).not.toHaveProperty("buyer_id");
    expect(row).not.toHaveProperty("affiliate_id");
    expect(row).not.toHaveProperty("reseller_id");
  });

  it("buyer can read their own subscriptions", async () => {
    const buyer1 = await signIn("buyer-1@test.com", "password123");
    const { data, error } = await buyer1
      .from("subscriptions")
      .select("id, buyer_id")
      .eq("buyer_id", IDs.BUYER_1);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    for (const row of data!) {
      expect(row.buyer_id).toBe(IDs.BUYER_1);
    }
  });

  it("buyer cannot read another buyer's subscriptions", async () => {
    const buyer1 = await signIn("buyer-1@test.com", "password123");
    const { data } = await buyer1
      .from("subscriptions")
      .select("id")
      .eq("buyer_id", IDs.BUYER_2);
    expect(data ?? []).toHaveLength(0);
  });
});

describeMaybe("RLS: profiles — privilege-escalation guard", () => {
  it("buyer cannot update their own role to admin", async () => {
    const buyer1 = await signIn("buyer-1@test.com", "password123");
    const { error } = await buyer1
      .from("profiles")
      .update({ role: "admin" as never })
      .eq("id", IDs.BUYER_1);
    expect(error).not.toBeNull();
  });

  it("buyer cannot update their own charges_enabled", async () => {
    const buyer1 = await signIn("buyer-1@test.com", "password123");
    const { error } = await buyer1
      .from("profiles")
      .update({ charges_enabled: true })
      .eq("id", IDs.BUYER_1);
    expect(error).not.toBeNull();
  });

  it("buyer can update their own display_name", async () => {
    const buyer1 = await signIn("buyer-1@test.com", "password123");
    const { error } = await buyer1
      .from("profiles")
      .update({ display_name: "Buyer One Updated" })
      .eq("id", IDs.BUYER_1);
    expect(error).toBeNull();
    // Restore
    await adminClient()
      .from("profiles")
      .update({ display_name: "Buyer One" })
      .eq("id", IDs.BUYER_1);
  });
});

describeMaybe("Seed data integrity", () => {
  it("canceled-then-resubscribed buyer has the same anon_user_id on both rows", async () => {
    const admin = adminClient();
    const { data, error } = await admin
      .from("subscriptions")
      .select("anon_user_id, status")
      .eq("buyer_id", IDs.BUYER_2)
      .eq("app_id", IDs.APP_1)
      .order("created_at", { ascending: true });

    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    expect(data![0].anon_user_id).toBe(data![1].anon_user_id);
    expect(data![0].status).toBe("canceled");
    expect(data![1].status).toBe("active");
  });

  it("vendor cannot set vendor_cut_bps_override on their own profile via REST", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { error } = await vendorA
      .from("profiles")
      .update({ vendor_cut_bps_override: 0 })
      .eq("id", IDs.VENDOR_A);
    // Trigger should reject the update with an exception
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/vendor_cut_bps_override can only be modified by admin/i);
  });

  it("vendor cannot set vendor_cut_bps_override on another vendor's profile", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { error } = await vendorA
      .from("profiles")
      .update({ vendor_cut_bps_override: 0 })
      .eq("id", IDs.VENDOR_B);
    expect(error).not.toBeNull();
  });

  it("vendor_b app is approved but does not appear in public listing (charges_enabled=false)", async () => {
    const admin = adminClient();
    const { data } = await admin
      .from("apps")
      .select("id, status, vendor_id")
      .eq("vendor_id", IDs.VENDOR_B);
    expect(data![0].status).toBe("approved");

    // Confirm it's absent from the public (anon) view
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY!, {
      auth: { persistSession: false },
    });
    const { data: publicData } = await anon
      .from("apps")
      .select("id")
      .eq("vendor_id", IDs.VENDOR_B);
    expect(publicData ?? []).toHaveLength(0);
  });
});
