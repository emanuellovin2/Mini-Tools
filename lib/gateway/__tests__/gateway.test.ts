import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Env stubs — must be set before modules load
// ---------------------------------------------------------------------------
process.env.KEY_VAULT_MASTER_KEYS = JSON.stringify({
  "1": Buffer.from(new Uint8Array(32).fill(0xab)).toString("base64"),
});
process.env.KEY_VAULT_ACTIVE_VERSION = "1";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/services/supabase", () => ({
  createAdminClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

vi.mock("@/lib/services/supabase-server", () => ({
  createServerSupabaseClient: vi.fn(),
}));

vi.mock("@/lib/services/admin", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/quotas/enforce", () => ({
  enforceQuota: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/utils/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59 }),
}));

vi.mock("@/lib/services/usage", () => ({
  recordUsage: vi.fn().mockResolvedValue({
    ok: true,
    deduped: false,
    blocked: false,
    remainingBalanceCents: 5000,
    eventId: "evt-1",
  }),
}));

vi.mock("@/lib/services/deployments", () => ({
  getEffectiveConfig: vi.fn().mockResolvedValue({
    deployment_id: "dep-1",
    solution_type: "agent",
    config: { solution_id: "sol-1" },
    status: "active",
    credit_wallet_owner: "client",
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { encryptSecret, decryptSecret } from "../crypto";
import { storeProviderKey, validateGatewayToken, GatewayError } from "@/lib/services/gateway";

beforeEach(() => vi.clearAllMocks());

// ── Crypto round-trip ──────────────────────────────────────────────────────

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext string", async () => {
    const plaintext = "sk-testkey-0123456789abcdef";
    const sealed = await encryptSecret(plaintext);

    expect(sealed.key_version).toBe(1);
    expect(sealed.ciphertext).not.toBe(plaintext);
    expect(sealed.dek_wrapped).toBeTruthy();

    const recovered = await decryptSecret(sealed);
    expect(recovered).toBe(plaintext);
  });

  it("produces distinct ciphertexts for identical plaintexts (random IV)", async () => {
    const plaintext = "sk-same-key";
    const a = await encryptSecret(plaintext);
    const b = await encryptSecret(plaintext);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.dek_wrapped).not.toBe(b.dek_wrapped);
  });

  it("decryptSecret fails with a tampered ciphertext", async () => {
    const sealed = await encryptSecret("secret");
    const tampered = { ...sealed, ciphertext: "aGVsbG8=" }; // random base64
    await expect(decryptSecret(tampered)).rejects.toThrow();
  });
});

// ── storeProviderKey ───────────────────────────────────────────────────────

describe("storeProviderKey", () => {
  it("stores encrypted key and returns metadata without plaintext", async () => {
    const insertChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: "key-1",
          owner_id: "org-1",
          provider: "openai",
          label: "prod key",
          last4: "cdef",
          key_version: 1,
          created_at: new Date().toISOString(),
        },
        error: null,
      }),
    };
    mockFrom.mockReturnValue(insertChain);

    const result = await storeProviderKey({
      ownerOrgId: "org-1",
      provider: "openai",
      label: "prod key",
      plaintext: "sk-testkey-0123456789abcdef",
      actorUserId: "user-1",
      actorOrgId: "org-1",
    });

    // Plaintext never in result
    expect(result).not.toHaveProperty("plaintext");
    expect(result).not.toHaveProperty("ciphertext");
    expect(result.last4).toBe("cdef");

    // Verify ciphertext was passed to insert (encrypted, not plaintext)
    const insertedPayload = insertChain.insert.mock.calls[0][0];
    expect(insertedPayload.ciphertext).toBeTruthy();
    expect(insertedPayload.ciphertext).not.toContain("sk-testkey");
  });
});

// ── validateGatewayToken ───────────────────────────────────────────────────

describe("validateGatewayToken", () => {
  it("returns null for revoked token", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: "tok-1",
          owner_id: "org-1",
          product_id: "prod-1",
          spend_cap_cents_daily: null,
          spend_cap_cents_monthly: null,
          spent_today_cents: 0,
          spent_month_cents: 0,
          spent_today_reset_at: "2026-05-28",
          spent_month_reset_at: "2026-05-01",
          paused_at: null,
          revoked_at: new Date().toISOString(), // revoked
        },
        error: null,
      }),
    };
    mockFrom.mockReturnValue(chain);

    const result = await validateGatewayToken("gw_test_rawtoken");
    expect(result).toBeNull();
  });

  it("returns null for paused token", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: "tok-2",
          owner_id: "org-1",
          product_id: "prod-1",
          spend_cap_cents_daily: null,
          spend_cap_cents_monthly: null,
          spent_today_cents: 0,
          spent_month_cents: 0,
          spent_today_reset_at: "2026-05-28",
          spent_month_reset_at: "2026-05-01",
          paused_at: new Date().toISOString(), // paused
          revoked_at: null,
        },
        error: null,
      }),
    };
    mockFrom.mockReturnValue(chain);

    const result = await validateGatewayToken("gw_test_rawtoken");
    expect(result).toBeNull();
  });
});

// ── GatewayError ───────────────────────────────────────────────────────────

describe("GatewayError", () => {
  it("carries status + code", () => {
    const err = new GatewayError(402, "insufficient_credits", "No credits");
    expect(err.status).toBe(402);
    expect(err.code).toBe("insufficient_credits");
    expect(err.message).toBe("No credits");
  });
});

// ── 402 on insufficient credits (reserve_credits blocks) ──────────────────

describe("resolveAndForward — 402 on no credits", () => {
  it("throws GatewayError 402 when reserve_credits returns blocked", async () => {
    const { resolveAndForward } = await import("@/lib/services/gateway");

    // gateway_products query returns a product
    const productChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: "prod-1",
          solution_id: "sol-1",
          meter_id: "meter-1",
          provider: "openai",
          model: "gpt-4o-mini",
          system_prompt: null,
          cost_mode: "byok",
          max_tokens_cap: 4096,
          default_key_id: "key-1",
        },
        error: null,
      }),
    };

    // provider_keys decrypt query
    const keyChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "not found" },
      }),
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === "gateway_products") return productChain;
      if (table === "provider_keys") return keyChain;
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    // reserve_credits returns blocked
    mockRpc.mockImplementation((fn: string) => {
      if (fn === "reserve_credits") {
        return Promise.resolve({
          data: { ok: false, blocked: true, reason: "insufficient_credits" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await expect(
      resolveAndForward({
        buyerId: "buyer-1",
        buyerOrgId: "org-1",
        deploymentId: "dep-1",
        body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 100 },
      })
    ).rejects.toMatchObject({ status: 402, code: "insufficient_credits" });
  });
});
