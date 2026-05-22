import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTransfersCreate = vi.fn();
const mockTransfersList = vi.fn();
const mockTransfersCreateReversal = vi.fn();

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    transfers: {
      create: mockTransfersCreate,
      list: mockTransfersList,
      createReversal: mockTransfersCreateReversal,
    },
  }),
}));

const mockAdminFrom = vi.fn();
vi.mock("@/lib/services/supabase", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

import { getVendorCutBps, transferVendorShare, reverseTransfers, reverseVendorTransfers } from "../transfers";

beforeEach(() => vi.clearAllMocks());

function buildSelectQuery(result: unknown) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = vi.fn().mockReturnValue(q);
  q.eq = vi.fn().mockReturnValue(q);
  q.lte = vi.fn().mockReturnValue(q);
  q.order = vi.fn().mockReturnValue(q);
  q.limit = vi.fn().mockReturnValue(q);
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  return q;
}

describe("getVendorCutBps", () => {
  it("returns cut_bps from vendor_billing when row exists", async () => {
    mockAdminFrom.mockReturnValue(buildSelectQuery({ data: { cut_bps: 1000 }, error: null }));
    expect(await getVendorCutBps("v1")).toBe(1000);
  });

  it("defaults to 1200 (Tier 1) when no billing row exists — SPEC §8", async () => {
    mockAdminFrom.mockReturnValue(buildSelectQuery({ data: null, error: null }));
    expect(await getVendorCutBps("v1")).toBe(1200);
  });
});

describe("transferVendorShare — split math", () => {
  beforeEach(() => {
    mockTransfersCreate.mockResolvedValue({ id: "tr_abc" });
  });

  it("Tier 1 (12% cut): vendor gets 88% of gross", async () => {
    const { vendorShareCents } = await transferVendorShare({
      invoiceId: "inv_1", amountCents: 10000, vendorId: "v1",
      stripeAccountId: "acct_1", cutBps: 1200,
    });
    expect(vendorShareCents).toBe(8800); // 10000 * 0.88
  });

  it("Tier 2 (8% cut): vendor gets 92% of gross", async () => {
    const { vendorShareCents } = await transferVendorShare({
      invoiceId: "inv_2", amountCents: 10000, vendorId: "v1",
      stripeAccountId: "acct_1", cutBps: 800,
    });
    expect(vendorShareCents).toBe(9200);
  });

  it("Tier 3 (5% cut): vendor gets 95% of gross", async () => {
    const { vendorShareCents } = await transferVendorShare({
      invoiceId: "inv_3", amountCents: 10000, vendorId: "v1",
      stripeAccountId: "acct_1", cutBps: 500,
    });
    expect(vendorShareCents).toBe(9500);
  });

  it("Tier 4 (3% cut): vendor gets 97% of gross", async () => {
    const { vendorShareCents } = await transferVendorShare({
      invoiceId: "inv_4", amountCents: 10000, vendorId: "v1",
      stripeAccountId: "acct_1", cutBps: 300,
    });
    expect(vendorShareCents).toBe(9700);
  });

  it("uses floor() for integer-safe split — no float leftovers", async () => {
    // $19.99 gross, Tier 1 (12%): floor(1999 * 8800 / 10000) = floor(1759.12) = 1759
    const { vendorShareCents } = await transferVendorShare({
      invoiceId: "inv_5", amountCents: 1999, vendorId: "v1",
      stripeAccountId: "acct_1", cutBps: 1200,
    });
    expect(vendorShareCents).toBe(1759);
    expect(Number.isInteger(vendorShareCents)).toBe(true);
  });

  it("uses idempotency key that encodes invoice_id + vendor_id", async () => {
    await transferVendorShare({
      invoiceId: "inv_6", amountCents: 5000, vendorId: "v2",
      stripeAccountId: "acct_1", cutBps: 1200,
    });
    const [, opts] = mockTransfersCreate.mock.calls[0];
    expect(opts.idempotencyKey).toBe("transfer:invoice_inv_6:vendor_v2");
  });

  it("sets transfer_group for traceability", async () => {
    await transferVendorShare({
      invoiceId: "inv_7", amountCents: 5000, vendorId: "v1",
      stripeAccountId: "acct_1", cutBps: 1200,
    });
    const [body] = mockTransfersCreate.mock.calls[0];
    expect(body.transfer_group).toBe("invoice_inv_7");
  });
});

describe("reverseTransfers", () => {
  it("reverses non-reversed transfers in the group", async () => {
    mockTransfersList.mockResolvedValue({
      data: [
        { id: "tr_1", reversed: false },
        { id: "tr_2", reversed: true }, // already reversed — skip
      ],
    });
    mockTransfersCreateReversal.mockResolvedValue({});

    await reverseTransfers({ invoiceId: "inv_x", chargeId: "ch_x" });

    expect(mockTransfersCreateReversal).toHaveBeenCalledTimes(1);
    expect(mockTransfersCreateReversal.mock.calls[0][0]).toBe("tr_1");
  });

  it("is idempotent — already-reversed transfers are skipped", async () => {
    mockTransfersList.mockResolvedValue({
      data: [{ id: "tr_1", reversed: true }],
    });

    await reverseTransfers({ invoiceId: "inv_x", chargeId: "ch_x" });
    expect(mockTransfersCreateReversal).not.toHaveBeenCalled();
  });

  it("uses idempotency key that encodes transfer_id + charge_id", async () => {
    mockTransfersList.mockResolvedValue({
      data: [{ id: "tr_abc", reversed: false }],
    });
    mockTransfersCreateReversal.mockResolvedValue({});

    await reverseTransfers({ invoiceId: "inv_x", chargeId: "ch_y" });
    const [, , opts] = mockTransfersCreateReversal.mock.calls[0];
    expect(opts.idempotencyKey).toBe("reversal:transfer_tr_abc:charge_ch_y");
  });
});

describe("reverseVendorTransfers — vendor-only policy", () => {
  it("only reverses transfers that have vendor_id in metadata", async () => {
    mockTransfersList.mockResolvedValue({
      data: [
        { id: "tr_vendor", reversed: false, metadata: { vendor_id: "v1", invoice_id: "inv_1" } },
        { id: "tr_affiliate", reversed: false, metadata: { affiliate_id: "aff_1", invoice_id: "inv_1" } },
        { id: "tr_reseller", reversed: false, metadata: { reseller_id: "rs_1", type: "reseller_markup" } },
      ],
    });
    mockTransfersCreateReversal.mockResolvedValue({});

    await reverseVendorTransfers({ invoiceId: "inv_1", chargeId: "ch_1" });

    expect(mockTransfersCreateReversal).toHaveBeenCalledTimes(1);
    expect(mockTransfersCreateReversal.mock.calls[0][0]).toBe("tr_vendor");
  });

  it("also reverses vendor_floor transfers (reseller sales — vendor still gets reversed)", async () => {
    mockTransfersList.mockResolvedValue({
      data: [
        { id: "tr_floor", reversed: false, metadata: { vendor_id: "v1", type: "vendor_floor" } },
        { id: "tr_markup", reversed: false, metadata: { reseller_id: "rs_1", type: "reseller_markup" } },
      ],
    });
    mockTransfersCreateReversal.mockResolvedValue({});

    await reverseVendorTransfers({ invoiceId: "inv_2", chargeId: "ch_2" });

    expect(mockTransfersCreateReversal).toHaveBeenCalledTimes(1);
    expect(mockTransfersCreateReversal.mock.calls[0][0]).toBe("tr_floor");
  });

  it("skips already-reversed vendor transfers", async () => {
    mockTransfersList.mockResolvedValue({
      data: [{ id: "tr_vendor", reversed: true, metadata: { vendor_id: "v1" } }],
    });

    await reverseVendorTransfers({ invoiceId: "inv_x", chargeId: "ch_x" });
    expect(mockTransfersCreateReversal).not.toHaveBeenCalled();
  });

  it("uses a distinct idempotency key with 'vendor' prefix", async () => {
    mockTransfersList.mockResolvedValue({
      data: [{ id: "tr_v", reversed: false, metadata: { vendor_id: "v1" } }],
    });
    mockTransfersCreateReversal.mockResolvedValue({});

    await reverseVendorTransfers({ invoiceId: "inv_z", chargeId: "ch_z" });
    const [, , opts] = mockTransfersCreateReversal.mock.calls[0];
    expect(opts.idempotencyKey).toBe("reversal:vendor:transfer_tr_v:charge_ch_z");
  });

  it("tags the reversal metadata with policy=vendor_only", async () => {
    mockTransfersList.mockResolvedValue({
      data: [{ id: "tr_v", reversed: false, metadata: { vendor_id: "v1" } }],
    });
    mockTransfersCreateReversal.mockResolvedValue({});

    await reverseVendorTransfers({ invoiceId: "inv_p", chargeId: "ch_p" });
    const [, body] = mockTransfersCreateReversal.mock.calls[0];
    expect(body.metadata?.policy).toBe("vendor_only");
  });
});
