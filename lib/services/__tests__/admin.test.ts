import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Supabase admin client
const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/services/supabase", () => ({
  createAdminClient: () => ({
    rpc: mockRpc,
    from: mockFrom,
  }),
}));

// Mock email so churn functions don't blow up
vi.mock("@/lib/email/resend", () => ({
  sendChurnAlert: vi.fn(),
  sendReconciliationDigest: vi.fn(),
}));

// Mock apps service (imported by admin.ts)
vi.mock("@/lib/services/apps", () => ({
  formatPrice: (cents: number, currency: string) => `${currency}${cents}`,
}));

import { setVendorCutOverride } from "../admin";

beforeEach(() => vi.clearAllMocks());

function buildFromChain(selectResult: unknown) {
  const q: Record<string, unknown> = {};
  q.select = vi.fn().mockReturnValue(q);
  q.eq = vi.fn().mockReturnValue(q);
  q.maybeSingle = vi.fn().mockResolvedValue(selectResult);
  return q;
}

describe("setVendorCutOverride", () => {
  const base = {
    adminId: "admin-uuid",
    vendorId: "vendor-uuid",
    reason: "Launch partner Q2 2026",
  };

  it("calls admin_set_vendor_cut_override RPC with correct args", async () => {
    mockFrom.mockReturnValue(
      buildFromChain({ data: { vendor_cut_bps_override: null, role: "vendor" }, error: null })
    );
    mockRpc.mockResolvedValue({ error: null });

    await setVendorCutOverride({ ...base, newBps: 0 });

    expect(mockRpc).toHaveBeenCalledWith("admin_set_vendor_cut_override", {
      p_admin_id: "admin-uuid",
      p_vendor_id: "vendor-uuid",
      p_new_bps: 0,
      p_reason: "Launch partner Q2 2026",
      p_old_bps: null,
    });
  });

  it("passes old override value to RPC for audit", async () => {
    mockFrom.mockReturnValue(
      buildFromChain({ data: { vendor_cut_bps_override: 500, role: "vendor" }, error: null })
    );
    mockRpc.mockResolvedValue({ error: null });

    await setVendorCutOverride({ ...base, newBps: 300 });

    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(rpcArgs.p_old_bps).toBe(500);
    expect(rpcArgs.p_new_bps).toBe(300);
  });

  it("accepts null newBps (clears override)", async () => {
    mockFrom.mockReturnValue(
      buildFromChain({ data: { vendor_cut_bps_override: 200, role: "vendor" }, error: null })
    );
    mockRpc.mockResolvedValue({ error: null });

    await expect(setVendorCutOverride({ ...base, newBps: null })).resolves.toBeUndefined();
    expect(mockRpc.mock.calls[0][1].p_new_bps).toBeNull();
  });

  it("rejects reason shorter than 10 chars", async () => {
    await expect(
      setVendorCutOverride({ ...base, newBps: 0, reason: "short" })
    ).rejects.toThrow("reason is required and must be ≥10 characters");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects newBps above 5000", async () => {
    await expect(
      setVendorCutOverride({ ...base, newBps: 5001 })
    ).rejects.toThrow("newBps must be 0..5000 or null");
  });

  it("rejects negative newBps", async () => {
    await expect(
      setVendorCutOverride({ ...base, newBps: -1 })
    ).rejects.toThrow("newBps must be 0..5000 or null");
  });

  it("rejects when target profile is not found", async () => {
    mockFrom.mockReturnValue(buildFromChain({ data: null, error: null }));

    await expect(setVendorCutOverride({ ...base, newBps: 0 })).rejects.toThrow(
      "vendor not found"
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects when target user is not a vendor", async () => {
    mockFrom.mockReturnValue(
      buildFromChain({ data: { vendor_cut_bps_override: null, role: "buyer" }, error: null })
    );

    await expect(setVendorCutOverride({ ...base, newBps: 0 })).rejects.toThrow(
      "target user is not a vendor"
    );
  });

  it("throws when RPC returns an error", async () => {
    mockFrom.mockReturnValue(
      buildFromChain({ data: { vendor_cut_bps_override: null, role: "vendor" }, error: null })
    );
    mockRpc.mockResolvedValue({ error: { message: "db error" } });

    await expect(setVendorCutOverride({ ...base, newBps: 100 })).rejects.toThrow(
      "setVendorCutOverride: db error"
    );
  });
});
