// @vitest-environment node
//
// Tests for vendor dashboard: price rounding, logo magic-byte validation,
// and storage RLS (vendor cannot write to another vendor's path).
// Requires local Supabase to be running for integration tests.

import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { detectLogoMimeType } from "@/lib/utils/magic-bytes";
import { appSubmitSchema } from "@/lib/validation/vendor";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const canRun = !!(ANON_KEY && SERVICE_KEY);
const describeMaybe = canRun ? describe : describe.skip;

const IDs = {
  VENDOR_A: "00000000-0000-0000-0000-000000000002",
  VENDOR_B: "00000000-0000-0000-0000-000000000003",
} as const;

async function signIn(email: string, password: string) {
  const client = createClient<Database>(SUPABASE_URL, ANON_KEY!, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn(${email}): ${error.message}`);
  return client;
}

// ── Unit: magic byte detection ────────────────────────────────────────────────

describe("detectLogoMimeType", () => {
  it("accepts a valid PNG", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(detectLogoMimeType(buf)).toBe("image/png");
  });

  it("accepts a valid JPEG", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    expect(detectLogoMimeType(buf)).toBe("image/jpeg");
  });

  it("accepts a valid WebP", () => {
    // RIFF + 4 bytes size + WEBP
    const buf = Buffer.alloc(12);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(100, 4);
    buf.write("WEBP", 8, "ascii");
    expect(detectLogoMimeType(buf)).toBe("image/webp");
  });

  it("rejects an SVG (XML text)", () => {
    const buf = Buffer.from("<svg xmlns=");
    expect(detectLogoMimeType(buf)).toBeNull();
  });

  it("rejects a PNG-renamed exe (MZ header)", () => {
    const buf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(detectLogoMimeType(buf)).toBeNull();
  });

  it("rejects an empty buffer", () => {
    expect(detectLogoMimeType(Buffer.alloc(0))).toBeNull();
  });
});

// ── Unit: price round-trip ────────────────────────────────────────────────────

describe("appSubmitSchema price → cents", () => {
  it("$9.99 stores as 999 cents", () => {
    const result = appSubmitSchema.safeParse({
      name: "Test",
      price_dollars: "9.99",
      auth_url: "https://example.com/auth",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Math.round(result.data.price_dollars * 100)).toBe(999);
    }
  });

  it("$100 stores as 10000 cents", () => {
    const result = appSubmitSchema.safeParse({
      name: "Test",
      price_dollars: "100",
      auth_url: "https://example.com/auth",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Math.round(result.data.price_dollars * 100)).toBe(10000);
    }
  });

  it("rejects non-https auth_url", () => {
    const result = appSubmitSchema.safeParse({
      name: "Test",
      price_dollars: "10",
      auth_url: "http://example.com/auth",
    });
    expect(result.success).toBe(false);
  });

  it("rejects min_price_dollars > price_dollars", () => {
    const result = appSubmitSchema.safeParse({
      name: "Test",
      price_dollars: "10",
      min_price_dollars: "20",
      auth_url: "https://example.com/auth",
    });
    expect(result.success).toBe(false);
  });

  it("accepts min_price_dollars <= price_dollars", () => {
    const result = appSubmitSchema.safeParse({
      name: "Test",
      price_dollars: "10",
      min_price_dollars: "7",
      auth_url: "https://example.com/auth",
    });
    expect(result.success).toBe(true);
  });

  it("accepts blank min_price_dollars (no resell opt-in)", () => {
    const result = appSubmitSchema.safeParse({
      name: "Test",
      price_dollars: "10",
      min_price_dollars: "",
      auth_url: "https://example.com/auth",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_price_dollars).toBeUndefined();
    }
  });
});

// ── Integration: storage RLS ──────────────────────────────────────────────────

describeMaybe("Storage RLS: app-logos", () => {
  it("vendor A can upload to their own path", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const path = `${IDs.VENDOR_A}/test-${Date.now()}.png`;
    const { error } = await vendorA.storage
      .from("app-logos")
      .upload(path, buf, { contentType: "image/png" });
    expect(error).toBeNull();

    // cleanup
    await vendorA.storage.from("app-logos").remove([path]);
  });

  it("vendor A cannot upload to vendor B's path", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const path = `${IDs.VENDOR_B}/stolen-logo-${Date.now()}.png`;
    const { error } = await vendorA.storage
      .from("app-logos")
      .upload(path, buf, { contentType: "image/png" });
    expect(error).not.toBeNull();
  });

  it("vendor_subscription_stats does not expose buyer identity", async () => {
    const vendorA = await signIn("vendor-a@test.com", "password123");
    const { data, error } = await vendorA.rpc("vendor_subscription_stats");
    expect(error).toBeNull();
    for (const row of data ?? []) {
      expect(row).not.toHaveProperty("buyer_id");
      expect(row).not.toHaveProperty("email");
    }
  });
});
