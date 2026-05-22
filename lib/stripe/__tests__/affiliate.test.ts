import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTransfersCreate = vi.fn();

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    transfers: { create: mockTransfersCreate },
  }),
}));

import { transferAffiliateShare } from "../transfers";

beforeEach(() => vi.clearAllMocks());

describe("transferAffiliateShare — affiliate split math (SPEC §4a)", () => {
  beforeEach(() => {
    mockTransfersCreate.mockResolvedValue({ id: "tr_aff_abc" });
  });

  it("Tier 1 (cut=20%): affiliate gets 10% of gross, platform keeps 10%", async () => {
    // $50 gross, cut_bps=2000 → affiliate = floor(5000 * 2000 / 20000) = floor(500) = 500 cents
    const { affiliateShareCents } = await transferAffiliateShare({
      invoiceId: "inv_1",
      amountCents: 5000,
      affiliateId: "aff_1",
      stripeAccountId: "acct_aff",
      cutBps: 2000,
    });
    expect(affiliateShareCents).toBe(500); // 10% of $50
  });

  it("Tier 2 (cut=10%): affiliate gets 5% of gross, platform keeps 5%", async () => {
    // $50 gross, cut_bps=1000 → affiliate = floor(5000 * 1000 / 20000) = floor(250) = 250 cents
    const { affiliateShareCents } = await transferAffiliateShare({
      invoiceId: "inv_2",
      amountCents: 5000,
      affiliateId: "aff_1",
      stripeAccountId: "acct_aff",
      cutBps: 1000,
    });
    expect(affiliateShareCents).toBe(250); // 5% of $50
  });

  it("Tier 3 (cut=5%): affiliate gets 2.5% of gross, platform keeps 2.5%", async () => {
    // $50 gross, cut_bps=500 → affiliate = floor(5000 * 500 / 20000) = floor(125) = 125 cents
    const { affiliateShareCents } = await transferAffiliateShare({
      invoiceId: "inv_3",
      amountCents: 5000,
      affiliateId: "aff_1",
      stripeAccountId: "acct_aff",
      cutBps: 500,
    });
    expect(affiliateShareCents).toBe(125); // 2.5% of $50
  });

  it("uses floor() for integer safety — no float remainders", async () => {
    // $19.99 gross, cut_bps=2000 → floor(1999 * 2000 / 20000) = floor(199.9) = 199
    const { affiliateShareCents } = await transferAffiliateShare({
      invoiceId: "inv_4",
      amountCents: 1999,
      affiliateId: "aff_1",
      stripeAccountId: "acct_aff",
      cutBps: 2000,
    });
    expect(affiliateShareCents).toBe(199);
    expect(Number.isInteger(affiliateShareCents)).toBe(true);
  });

  it("uses idempotency key encoding invoice_id + affiliate_id", async () => {
    await transferAffiliateShare({
      invoiceId: "inv_5",
      amountCents: 5000,
      affiliateId: "aff_42",
      stripeAccountId: "acct_aff",
      cutBps: 2000,
    });
    const [, opts] = mockTransfersCreate.mock.calls[0];
    expect(opts.idempotencyKey).toBe("transfer:invoice_inv_5:affiliate_aff_42");
  });

  it("sets transfer_group matching the invoice", async () => {
    await transferAffiliateShare({
      invoiceId: "inv_6",
      amountCents: 5000,
      affiliateId: "aff_1",
      stripeAccountId: "acct_aff",
      cutBps: 2000,
    });
    const [body] = mockTransfersCreate.mock.calls[0];
    expect(body.transfer_group).toBe("invoice_inv_6");
  });

  it("vendor share + affiliate share + platform share = gross (Tier 1, round numbers)", () => {
    // $100 gross, cut_bps=2000
    // vendor = floor(10000 * 8000 / 10000) = 8000 (80%)
    // affiliate = floor(10000 * 2000 / 20000) = 1000 (10%)
    // platform = 10000 - 8000 - 1000 = 1000 (10%)
    const gross = 10000;
    const cutBps = 2000;
    const vendorShare = Math.floor((gross * (10_000 - cutBps)) / 10_000);
    const affiliateShare = Math.floor((gross * cutBps) / 20_000);
    const platformShare = gross - vendorShare - affiliateShare;

    expect(vendorShare).toBe(8000);
    expect(affiliateShare).toBe(1000);
    expect(platformShare).toBe(1000);
    expect(vendorShare + affiliateShare + platformShare).toBe(gross);
  });

  it("vendor share + affiliate share + platform share = gross (Tier 2)", () => {
    const gross = 10000;
    const cutBps = 1000;
    const vendorShare = Math.floor((gross * (10_000 - cutBps)) / 10_000);
    const affiliateShare = Math.floor((gross * cutBps) / 20_000);
    const platformShare = gross - vendorShare - affiliateShare;

    expect(vendorShare).toBe(9000);
    expect(affiliateShare).toBe(500);
    expect(platformShare).toBe(500);
    expect(vendorShare + affiliateShare + platformShare).toBe(gross);
  });

  it("vendor share + affiliate share + platform share = gross (Tier 3)", () => {
    const gross = 10000;
    const cutBps = 500;
    const vendorShare = Math.floor((gross * (10_000 - cutBps)) / 10_000);
    const affiliateShare = Math.floor((gross * cutBps) / 20_000);
    const platformShare = gross - vendorShare - affiliateShare;

    expect(vendorShare).toBe(9500);
    expect(affiliateShare).toBe(250);
    expect(platformShare).toBe(250);
    expect(vendorShare + affiliateShare + platformShare).toBe(gross);
  });
});
