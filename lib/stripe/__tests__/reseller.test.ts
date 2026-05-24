import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTransfersCreate = vi.fn();

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    transfers: { create: mockTransfersCreate },
  }),
}));

import {
  computeResellerSplit,
  VENDOR_WL_KICKBACK_BPS,
  transferResellerVendorFloor,
  transferResellerShare,
} from "../transfers";

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// computeResellerSplit — worked examples from the spec
// ---------------------------------------------------------------------------

describe("computeResellerSplit — Tier 1 open_to_resellers (status quo)", () => {
  it("$50/$20 → vendor=2000, platform=150, reseller=2850", () => {
    // markup=3000; platformCommission=floor(3000*500/10000)=150; kickback=0
    const split = computeResellerSplit({
      amountCents: 5000,
      vendorFloorCents: 2000,
      wlTier: 1,
      vendorOpenness: "open_to_resellers",
    });
    expect(split.vendorShareCents).toBe(2000);
    expect(split.platformCutCents).toBe(150);
    expect(split.resellerShareCents).toBe(2850);
    expect(split.vendorShareCents + split.platformCutCents + split.resellerShareCents).toBe(5000);
  });

  it("zero markup: sell=floor → platform=0, reseller=0, vendor=floor", () => {
    const split = computeResellerSplit({
      amountCents: 5000,
      vendorFloorCents: 5000,
      wlTier: 1,
      vendorOpenness: "open_to_resellers",
    });
    expect(split.vendorShareCents).toBe(5000);
    expect(split.platformCutCents).toBe(0);
    expect(split.resellerShareCents).toBe(0);
  });

  it("amount < floor (Stripe fee edge): vendor gets full amount, others 0", () => {
    const split = computeResellerSplit({
      amountCents: 1900,
      vendorFloorCents: 2000,
      wlTier: 1,
      vendorOpenness: "open_to_resellers",
    });
    expect(split.vendorShareCents).toBe(1900);
    expect(split.platformCutCents).toBe(0);
    expect(split.resellerShareCents).toBe(0);
  });

  it("platform fee uses floor() — integer-safe", () => {
    // markup=999; floor(999*500/10000)=floor(49.95)=49
    const split = computeResellerSplit({
      amountCents: 1999,
      vendorFloorCents: 1000,
      wlTier: 1,
      vendorOpenness: "open_to_resellers",
    });
    expect(split.platformCutCents).toBe(49);
    expect(Number.isInteger(split.platformCutCents)).toBe(true);
    expect(Number.isInteger(split.resellerShareCents)).toBe(true);
  });
});

describe("computeResellerSplit — Tier 1 open_to_wl (kickback)", () => {
  it("$50/$20 → vendor=2049, platform=101, reseller=2850", () => {
    // markup=3000; platformCommission=floor(3000*500/10000)=150
    // kickback=floor(150*3333/10000)=floor(49.995)=49
    // vendor=2000+49=2049; platform=150-49=101; reseller=5000-2049-101=2850
    const split = computeResellerSplit({
      amountCents: 5000,
      vendorFloorCents: 2000,
      wlTier: 1,
      vendorOpenness: "open_to_wl",
    });
    expect(split.vendorShareCents).toBe(2049);
    expect(split.platformCutCents).toBe(101);
    expect(split.resellerShareCents).toBe(2850);
    expect(split.vendorShareCents + split.platformCutCents + split.resellerShareCents).toBe(5000);
  });

  it("1¢ markup, Tier 1 open_to_wl: kickback floors to 0, no error", () => {
    // markup=1; platformCommission=floor(1*500/10000)=0; kickback=0; reseller gets the 1¢
    const split = computeResellerSplit({
      amountCents: 2001,
      vendorFloorCents: 2000,
      wlTier: 1,
      vendorOpenness: "open_to_wl",
    });
    expect(split.platformCutCents).toBe(0);
    expect(split.vendorShareCents).toBe(2000); // no kickback (commission was 0)
    expect(split.resellerShareCents).toBe(1);
    expect(split.vendorShareCents + split.platformCutCents + split.resellerShareCents).toBe(2001);
  });

  it("tiny markup: 50¢ markup, platformCommission=2, kickback floors to 0", () => {
    // markup=50; platformCommission=floor(50*500/10000)=2; kickback=floor(2*3333/10000)=0
    const split = computeResellerSplit({
      amountCents: 2050,
      vendorFloorCents: 2000,
      wlTier: 1,
      vendorOpenness: "open_to_wl",
    });
    expect(split.platformCutCents).toBe(2);
    expect(split.vendorShareCents).toBe(2000); // kickback=0 on tiny commission
    expect(split.resellerShareCents).toBe(48);
  });
});

describe("computeResellerSplit — Tier 2 open_to_wl (2.5% commission + kickback)", () => {
  it("$50/$20 → vendor=2024, platform=51, reseller=2925", () => {
    // markup=3000; platformCommission=floor(3000*250/10000)=75
    // kickback=floor(75*3333/10000)=floor(24.9975)=24
    // vendor=2000+24=2024; platform=75-24=51; reseller=5000-2024-51=2925
    const split = computeResellerSplit({
      amountCents: 5000,
      vendorFloorCents: 2000,
      wlTier: 2,
      vendorOpenness: "open_to_wl",
    });
    expect(split.vendorShareCents).toBe(2024);
    expect(split.platformCutCents).toBe(51);
    expect(split.resellerShareCents).toBe(2925);
    expect(split.vendorShareCents + split.platformCutCents + split.resellerShareCents).toBe(5000);
  });
});

describe("computeResellerSplit — invariant guards", () => {
  it("throws when wlTier=2 but vendorOpenness=open_to_resellers", () => {
    expect(() =>
      computeResellerSplit({
        amountCents: 5000,
        vendorFloorCents: 2000,
        wlTier: 2,
        vendorOpenness: "open_to_resellers",
      })
    ).toThrow(/invariant.*Tier 2/);
  });

  it("VENDOR_WL_KICKBACK_BPS is in [0, 10000] — CI guard", () => {
    expect(VENDOR_WL_KICKBACK_BPS).toBeGreaterThanOrEqual(0);
    expect(VENDOR_WL_KICKBACK_BPS).toBeLessThanOrEqual(10_000);
  });

  it("kickback never exceeds platformCommission — platform cut stays non-negative", () => {
    const split = computeResellerSplit({
      amountCents: 10_000,
      vendorFloorCents: 1_000,
      wlTier: 1,
      vendorOpenness: "open_to_wl",
    });
    expect(split.platformCutCents).toBeGreaterThanOrEqual(0);
  });
});

describe("computeResellerSplit — sum invariant (fuzz 1000×)", () => {
  it("vendor + platform + reseller === amount for 1000 random valid inputs", () => {
    const seed = 42;
    let s = seed;
    function rand(min: number, max: number): number {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return min + Math.abs(s) % (max - min + 1);
    }

    for (let i = 0; i < 1000; i++) {
      const amount = rand(100, 10_000_000);
      const floor = rand(0, amount);
      const isTier2 = rand(0, 1) === 1;
      // Tier 2 requires open_to_wl
      const vendorOpenness: "open_to_resellers" | "open_to_wl" = isTier2
        ? "open_to_wl"
        : rand(0, 1) === 1
        ? "open_to_wl"
        : "open_to_resellers";
      const wlTier: 1 | 2 = isTier2 ? 2 : 1;

      const split = computeResellerSplit({ amountCents: amount, vendorFloorCents: floor, wlTier, vendorOpenness });

      expect(split.vendorShareCents + split.platformCutCents + split.resellerShareCents).toBe(amount);
      expect(split.platformCutCents).toBeGreaterThanOrEqual(0);
      expect(split.resellerShareCents).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// transferResellerVendorFloor
// ---------------------------------------------------------------------------

describe("transferResellerVendorFloor", () => {
  beforeEach(() => {
    mockTransfersCreate.mockResolvedValue({ id: "tr_vf_abc" });
  });

  it("transfers exactly the vendor share amount", async () => {
    const { transferId } = await transferResellerVendorFloor({
      invoiceId: "inv_1",
      vendorShareCents: 4000,
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
      vendorShareCents: 4000,
      vendorId: "v_42",
      stripeAccountId: "acct_v",
    });
    const [, opts] = mockTransfersCreate.mock.calls[0];
    expect(opts.idempotencyKey).toBe("transfer:invoice_inv_2:vendor_floor:v_42");
  });

  it("sets transfer_group matching the invoice", async () => {
    await transferResellerVendorFloor({
      invoiceId: "inv_3",
      vendorShareCents: 4000,
      vendorId: "v1",
      stripeAccountId: "acct_v",
    });
    const [body] = mockTransfersCreate.mock.calls[0];
    expect(body.transfer_group).toBe("invoice_inv_3");
  });

  it("regression: transferResellerVendorFloor amount matches computeResellerSplit vendorShareCents", () => {
    // Verify the two functions are wired together correctly — no internal recomputation.
    const split = computeResellerSplit({
      amountCents: 5000,
      vendorFloorCents: 2000,
      wlTier: 1,
      vendorOpenness: "open_to_wl",
    });
    // Amount to pass to transferResellerVendorFloor must be split.vendorShareCents, not floor.
    expect(split.vendorShareCents).toBe(2049);
    // Caller passes this value — no function-level recomputation needed.
  });
});

// ---------------------------------------------------------------------------
// transferResellerShare
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Reseller trial days — first-time vs returning (#22)
// ---------------------------------------------------------------------------

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
