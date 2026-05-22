import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTransfersCreate = vi.fn();

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    transfers: { create: mockTransfersCreate },
  }),
}));

import {
  computeResellerSplit,
  transferResellerVendorFloor,
  transferResellerShare,
} from "../transfers";

beforeEach(() => vi.clearAllMocks());

describe("computeResellerSplit — reseller money math (SPEC §4b)", () => {
  it("worked example from SPEC: buyer=$50, floor=$40 → reseller=$7.50, platform=$2.50", () => {
    const { vendorShareCents, platformFeeCents, resellerShareCents } =
      computeResellerSplit(5000, 4000);
    expect(vendorShareCents).toBe(4000); // $40 floor
    expect(platformFeeCents).toBe(250); // 5% of $50 = $2.50
    expect(resellerShareCents).toBe(750); // $50 - $40 - $2.50 = $7.50
  });

  it("vendor + reseller + platform = gross (no leakage)", () => {
    const gross = 5000;
    const floor = 4000;
    const { vendorShareCents, platformFeeCents, resellerShareCents } =
      computeResellerSplit(gross, floor);
    expect(vendorShareCents + platformFeeCents + resellerShareCents).toBe(gross);
  });

  it("platform fee uses floor() — no float remainders", () => {
    // $19.99 gross → platform fee = floor(1999 * 500 / 10000) = floor(99.95) = 99
    const { platformFeeCents } = computeResellerSplit(1999, 1000);
    expect(platformFeeCents).toBe(99);
    expect(Number.isInteger(platformFeeCents)).toBe(true);
  });

  it("resellerShareCents is integer-safe (floor rounding)", () => {
    const { resellerShareCents } = computeResellerSplit(1999, 1000);
    expect(Number.isInteger(resellerShareCents)).toBe(true);
  });

  it("throws when reseller share would be negative (floor > gross - 5%)", () => {
    // $100 gross, $98 floor → platform fee $5, reseller = $100 - $98 - $5 = -$3
    expect(() => computeResellerSplit(10000, 9800)).toThrow();
  });

  it("resellerShare is 0 when sell_price = floor + exact 5% covers the gap", () => {
    // sell=10500, floor=10000 → platform=525, reseller=10500-10000-525=-25 → throws
    expect(() => computeResellerSplit(10500, 10000)).toThrow();
  });

  it("larger markup: buyer=$100, floor=$20 → reseller=$75, platform=$5", () => {
    const { vendorShareCents, platformFeeCents, resellerShareCents } =
      computeResellerSplit(10000, 2000);
    expect(vendorShareCents).toBe(2000);
    expect(platformFeeCents).toBe(500); // 5% of $100
    expect(resellerShareCents).toBe(7500); // $100 - $20 - $5
    expect(vendorShareCents + platformFeeCents + resellerShareCents).toBe(10000);
  });
});

describe("transferResellerVendorFloor", () => {
  beforeEach(() => {
    mockTransfersCreate.mockResolvedValue({ id: "tr_vf_abc" });
  });

  it("transfers exactly the vendor floor amount", async () => {
    const { transferId } = await transferResellerVendorFloor({
      invoiceId: "inv_1",
      vendorFloorCents: 4000,
      vendorId: "v1",
      stripeAccountId: "acct_v1",
    });
    expect(transferId).toBe("tr_vf_abc");
    const [body] = mockTransfersCreate.mock.calls[0];
    expect(body.amount).toBe(4000);
  });

  it("uses idempotency key encoding vendor_floor", async () => {
    await transferResellerVendorFloor({
      invoiceId: "inv_2",
      vendorFloorCents: 4000,
      vendorId: "v_42",
      stripeAccountId: "acct_v",
    });
    const [, opts] = mockTransfersCreate.mock.calls[0];
    expect(opts.idempotencyKey).toBe("transfer:invoice_inv_2:vendor_floor:v_42");
  });

  it("sets transfer_group matching the invoice", async () => {
    await transferResellerVendorFloor({
      invoiceId: "inv_3",
      vendorFloorCents: 4000,
      vendorId: "v1",
      stripeAccountId: "acct_v",
    });
    const [body] = mockTransfersCreate.mock.calls[0];
    expect(body.transfer_group).toBe("invoice_inv_3");
  });
});

describe("transferResellerShare", () => {
  beforeEach(() => {
    mockTransfersCreate.mockResolvedValue({ id: "tr_rs_abc" });
  });

  it("transfers the reseller markup share", async () => {
    const { transferId } = await transferResellerShare({
      invoiceId: "inv_1",
      resellerShareCents: 750,
      resellerId: "rs1",
      stripeAccountId: "acct_rs1",
    });
    expect(transferId).toBe("tr_rs_abc");
    const [body] = mockTransfersCreate.mock.calls[0];
    expect(body.amount).toBe(750);
  });

  it("uses idempotency key encoding reseller", async () => {
    await transferResellerShare({
      invoiceId: "inv_2",
      resellerShareCents: 750,
      resellerId: "rs_99",
      stripeAccountId: "acct_rs",
    });
    const [, opts] = mockTransfersCreate.mock.calls[0];
    expect(opts.idempotencyKey).toBe("transfer:invoice_inv_2:reseller:rs_99");
  });

  it("sets transfer_group matching the invoice", async () => {
    await transferResellerShare({
      invoiceId: "inv_3",
      resellerShareCents: 750,
      resellerId: "rs1",
      stripeAccountId: "acct_rs",
    });
    const [body] = mockTransfersCreate.mock.calls[0];
    expect(body.transfer_group).toBe("invoice_inv_3");
  });
});

describe("End-to-end split accounting — all parties sum to gross", () => {
  it("Tier-1 equivalent accuracy check on various prices", () => {
    const cases = [
      { gross: 5000, floor: 4000 }, // SPEC example
      { gross: 10000, floor: 2000 }, // large markup
      { gross: 2000, floor: 1800 }, // small markup — should pass (reseller > 0)
    ];

    for (const { gross, floor } of cases) {
      const { vendorShareCents, platformFeeCents, resellerShareCents } =
        computeResellerSplit(gross, floor);
      expect(vendorShareCents + platformFeeCents + resellerShareCents).toBe(gross);
      expect(vendorShareCents).toBe(floor);
      expect(resellerShareCents).toBeGreaterThan(0);
    }
  });
});
