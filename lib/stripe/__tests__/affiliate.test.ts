import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTransfersCreate = vi.fn();

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    transfers: { create: mockTransfersCreate },
  }),
}));

import { transferAffiliateShare } from "../transfers";
import { computeAffiliateSplit, getAffiliateCommissionBps } from "../transfers";

beforeEach(() => vi.clearAllMocks());

// ── computeAffiliateSplit (pure function) ─────────────────────────────────────

describe("computeAffiliateSplit — new vendor-funded model (SPEC §4a, #18)", () => {
  it("5% platform + 20% affiliate + 75% vendor on $100 net", () => {
    const { platformFeeCents, affiliateShareCents, vendorShareCents } =
      computeAffiliateSplit(10_000, 2000);
    expect(platformFeeCents).toBe(500);    // 5%
    expect(affiliateShareCents).toBe(2000); // 20%
    expect(vendorShareCents).toBe(7500);   // 75%
    expect(platformFeeCents + affiliateShareCents + vendorShareCents).toBe(10_000);
  });

  it("5% platform + 30% affiliate + 65% vendor (top tier)", () => {
    const { platformFeeCents, affiliateShareCents, vendorShareCents } =
      computeAffiliateSplit(10_000, 3000);
    expect(platformFeeCents).toBe(500);
    expect(affiliateShareCents).toBe(3000);
    expect(vendorShareCents).toBe(6500);
    expect(platformFeeCents + affiliateShareCents + vendorShareCents).toBe(10_000);
  });

  it("uses floor() for integer safety — $97 net, 20% affiliate", () => {
    // platform: floor(9700 * 500 / 10000) = floor(485) = 485
    // affiliate: floor(9700 * 2000 / 10000) = floor(1940) = 1940
    // vendor: 9700 - 485 - 1940 = 7275
    const { platformFeeCents, affiliateShareCents, vendorShareCents } =
      computeAffiliateSplit(9_700, 2000);
    expect(platformFeeCents).toBe(485);
    expect(affiliateShareCents).toBe(1940);
    expect(vendorShareCents).toBe(7275);
    expect(Number.isInteger(vendorShareCents)).toBe(true);
  });

  it("throws when vendor share would go negative (affiliateBps too high)", () => {
    // affiliateBps=9600 + platform 5% = 101% → vendor gets -1%
    expect(() => computeAffiliateSplit(10_000, 9600)).toThrow(
      "negative vendor share"
    );
  });

  it("80% affiliate (max) + 5% platform = 15% vendor — valid", () => {
    const { vendorShareCents } = computeAffiliateSplit(10_000, 8000);
    expect(vendorShareCents).toBe(1500); // 15%
  });
});

// ── getAffiliateCommissionBps (pure function) ─────────────────────────────────

describe("getAffiliateCommissionBps — tier thresholds", () => {
  it("returns 2000 (20%) for $0 active MRR", () => {
    expect(getAffiliateCommissionBps(0)).toBe(2000);
  });

  it("returns 2000 (20%) just below $5k threshold ($4999)", () => {
    expect(getAffiliateCommissionBps(499_900)).toBe(2000);
  });

  it("returns 2500 (25%) at exactly $5k active MRR", () => {
    expect(getAffiliateCommissionBps(500_000)).toBe(2500);
  });

  it("returns 2500 (25%) just below $20k threshold ($19,999)", () => {
    expect(getAffiliateCommissionBps(1_999_900)).toBe(2500);
  });

  it("returns 3000 (30%) at exactly $20k active MRR", () => {
    expect(getAffiliateCommissionBps(2_000_000)).toBe(3000);
  });

  it("returns 3000 (30%) well above $20k", () => {
    expect(getAffiliateCommissionBps(5_000_000)).toBe(3000);
  });
});

// ── transferAffiliateShare (new signature) ────────────────────────────────────

describe("transferAffiliateShare — new signature (affiliateShareCents pre-computed)", () => {
  beforeEach(() => {
    mockTransfersCreate.mockResolvedValue({ id: "tr_aff_abc" });
  });

  it("transfers the exact affiliateShareCents provided", async () => {
    await transferAffiliateShare({
      invoiceId: "inv_1",
      affiliateShareCents: 1940,
      affiliateId: "aff_1",
      stripeAccountId: "acct_aff",
    });
    const [body] = mockTransfersCreate.mock.calls[0];
    expect(body.amount).toBe(1940);
  });

  it("uses idempotency key encoding invoice_id + affiliate_id", async () => {
    await transferAffiliateShare({
      invoiceId: "inv_5",
      affiliateShareCents: 500,
      affiliateId: "aff_42",
      stripeAccountId: "acct_aff",
    });
    const [, opts] = mockTransfersCreate.mock.calls[0];
    expect(opts.idempotencyKey).toBe("transfer:invoice_inv_5:affiliate_aff_42");
  });

  it("sets transfer_group matching the invoice", async () => {
    await transferAffiliateShare({
      invoiceId: "inv_6",
      affiliateShareCents: 500,
      affiliateId: "aff_1",
      stripeAccountId: "acct_aff",
    });
    const [body] = mockTransfersCreate.mock.calls[0];
    expect(body.transfer_group).toBe("invoice_inv_6");
  });

  it("returns affiliateShareCents from result", async () => {
    const { affiliateShareCents } = await transferAffiliateShare({
      invoiceId: "inv_7",
      affiliateShareCents: 2000,
      affiliateId: "aff_1",
      stripeAccountId: "acct_aff",
    });
    expect(affiliateShareCents).toBe(2000);
  });
});
