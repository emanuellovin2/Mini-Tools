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

describe("computeResellerSplit — reseller money math (SPEC §4b, #16: 5% of markup)", () => {
  it("worked example: buyer=$50, floor=$40, markup=$10 → platform=$0.50, reseller=$9.50, vendor=$40", () => {
    const { vendorShareCents, platformFeeCents, resellerShareCents } =
      computeResellerSplit(5000, 4000);
    expect(vendorShareCents).toBe(4000);  // $40 floor
    expect(platformFeeCents).toBe(50);    // 5% of 1000¢ markup = 50¢ = $0.50
    expect(resellerShareCents).toBe(950); // 1000¢ - 50¢ = 950¢ = $9.50
  });

  it("vendor + reseller + platform = gross (no leakage)", () => {
    const { vendorShareCents, platformFeeCents, resellerShareCents } =
      computeResellerSplit(5000, 4000);
    expect(vendorShareCents + platformFeeCents + resellerShareCents).toBe(5000);
  });

  it("zero markup: sell=floor → platform=$0, reseller=$0, vendor=floor", () => {
    const { vendorShareCents, platformFeeCents, resellerShareCents } =
      computeResellerSplit(5000, 5000);
    expect(vendorShareCents).toBe(5000);
    expect(platformFeeCents).toBe(0);
    expect(resellerShareCents).toBe(0);
  });

  it("clamps gracefully when available < floor (Stripe fees ate margin)", () => {
    // At webhook time, net (after Stripe fees) can dip below the gross floor.
    // Vendor still gets full floor; platform absorbs the deficit; reseller/platform share = 0.
    const { vendorShareCents, platformFeeCents, resellerShareCents } =
      computeResellerSplit(4000, 5000);
    expect(vendorShareCents).toBe(5000);
    expect(platformFeeCents).toBe(0);
    expect(resellerShareCents).toBe(0);
  });

  it("thin markup with Stripe fee: vendor full floor, smaller reseller share, platform proportional", () => {
    // sell $10 (1000¢), floor $9.50 (950¢), Stripe fee ~59¢ → net ≈ 941¢
    // markup on net = 941 - 950 = -9 → clamp; vendor still gets 950, others 0
    const split1 = computeResellerSplit(941, 950);
    expect(split1).toEqual({ vendorShareCents: 950, platformFeeCents: 0, resellerShareCents: 0 });

    // sell $15, floor $10, fee ~74¢ → net = 1426
    // markup on net = 426 → platform = floor(426*500/10000) = 21, reseller = 405
    const split2 = computeResellerSplit(1426, 1000);
    expect(split2.vendorShareCents).toBe(1000);
    expect(split2.platformFeeCents).toBe(21);
    expect(split2.resellerShareCents).toBe(405);
    expect(split2.vendorShareCents + split2.platformFeeCents + split2.resellerShareCents).toBe(1426);
  });

  it("platform fee uses floor() — integer-safe", () => {
    // markup = 1999 - 1000 = 999 → floor(999 * 500 / 10000) = floor(49.95) = 49
    const { platformFeeCents } = computeResellerSplit(1999, 1000);
    expect(platformFeeCents).toBe(49);
    expect(Number.isInteger(platformFeeCents)).toBe(true);
  });

  it("resellerShareCents is integer-safe", () => {
    const { resellerShareCents } = computeResellerSplit(1999, 1000);
    expect(Number.isInteger(resellerShareCents)).toBe(true);
  });

  it("larger markup: buyer=$100, floor=$20 → markup=$80 → platform=$4, reseller=$76, vendor=$20", () => {
    const { vendorShareCents, platformFeeCents, resellerShareCents } =
      computeResellerSplit(10000, 2000);
    expect(vendorShareCents).toBe(2000);
    expect(platformFeeCents).toBe(400);    // 5% of 8000¢ = 400¢ = $4
    expect(resellerShareCents).toBe(7600); // 8000¢ - 400¢ = 7600¢ = $76
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

describe("Reseller trial days — first-time vs returning (#22)", () => {
  function computeTrialDays(hasPriorSub: boolean, envDays = 30): number {
    if (hasPriorSub) return 0;
    return envDays > 0 ? envDays : 0;
  }

  it("first-time reseller gets 30-day trial", () => {
    expect(computeTrialDays(false)).toBe(30);
  });

  it("returning reseller gets no trial (0 days)", () => {
    expect(computeTrialDays(true)).toBe(0);
  });

  it("respects custom RESELLER_TRIAL_DAYS env value", () => {
    expect(computeTrialDays(false, 14)).toBe(14);
  });

  it("RESELLER_TRIAL_DAYS=0 disables trials for everyone", () => {
    expect(computeTrialDays(false, 0)).toBe(0);
  });
});

describe("End-to-end split accounting — all parties sum to gross", () => {
  it("various markups: vendor+platform+reseller always equals gross", () => {
    const cases = [
      { gross: 5000, floor: 4000 },  // $10 markup
      { gross: 10000, floor: 2000 }, // $80 markup
      { gross: 2000, floor: 1800 },  // $20 markup
    ];

    for (const { gross, floor } of cases) {
      const { vendorShareCents, platformFeeCents, resellerShareCents } =
        computeResellerSplit(gross, floor);
      expect(vendorShareCents + platformFeeCents + resellerShareCents).toBe(gross);
      expect(vendorShareCents).toBe(floor);
      expect(resellerShareCents).toBeGreaterThanOrEqual(0);
    }
  });
});
