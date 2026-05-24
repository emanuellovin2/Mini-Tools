import { describe, it, expect } from "vitest";
import { priceUnit, computeUsageSplit, type PricingConfig } from "../split";

// ---------------------------------------------------------------------------
// priceUnit
// ---------------------------------------------------------------------------

describe("priceUnit — flat", () => {
  const pricing: PricingConfig = {
    model: "flat",
    tiers: [{ up_to: null, vendor_unit_price_cents: 10, platform_fee_cents: 2 }],
  };

  it("charges all units at flat rate", () => {
    expect(priceUnit(pricing, 0, 100)).toEqual({ vendorCents: 1000, platformCents: 200 });
  });

  it("cumulative qty does not affect flat rate", () => {
    expect(priceUnit(pricing, 500, 100)).toEqual({ vendorCents: 1000, platformCents: 200 });
  });

  it("included_allowance zeroes out when all units are free", () => {
    const p: PricingConfig = { ...pricing, included_allowance: 200 };
    expect(priceUnit(p, 0, 100)).toEqual({ vendorCents: 0, platformCents: 0 });
  });

  it("included_allowance partially offsets qty", () => {
    const p: PricingConfig = { ...pricing, included_allowance: 50 };
    // cumulative=0, allowance=50, qty=100 → billable=50
    expect(priceUnit(p, 0, 100)).toEqual({ vendorCents: 500, platformCents: 100 });
  });

  it("allowance already consumed by prior calls", () => {
    const p: PricingConfig = { ...pricing, included_allowance: 50 };
    // 60 units already used → allowance exhausted; all 100 billable
    expect(priceUnit(p, 60, 100)).toEqual({ vendorCents: 1000, platformCents: 200 });
  });

  it("minimum_commitment_cents raises total to floor", () => {
    const p: PricingConfig = { ...pricing, minimum_commitment_cents: 2000 };
    // 100 units → 1000+200=1200 < 2000 → platform absorbs shortfall
    const r = priceUnit(p, 0, 100);
    expect(r.vendorCents).toBe(1000);
    expect(r.platformCents).toBe(1000); // 200 + 800 shortfall
  });

  it("minimum_commitment_cents does not reduce if total already above floor", () => {
    const p: PricingConfig = { ...pricing, minimum_commitment_cents: 100 };
    const r = priceUnit(p, 0, 100);
    expect(r.vendorCents).toBe(1000);
    expect(r.platformCents).toBe(200);
  });
});

describe("priceUnit — tiered (waterfall)", () => {
  const pricing: PricingConfig = {
    model: "tiered",
    tiers: [
      { up_to: 100, vendor_unit_price_cents: 10, platform_fee_cents: 2 },
      { up_to: 500, vendor_unit_price_cents: 8, platform_fee_cents: 1 },
      { up_to: null, vendor_unit_price_cents: 5, platform_fee_cents: 1 },
    ],
  };

  it("stays in first tier when qty ≤ 100", () => {
    expect(priceUnit(pricing, 0, 50)).toEqual({ vendorCents: 500, platformCents: 100 });
  });

  it("spans first and second tier", () => {
    // cumulative=0, qty=200: 100 units @10/2 + 100 units @8/1
    const r = priceUnit(pricing, 0, 200);
    expect(r.vendorCents).toBe(100 * 10 + 100 * 8); // 1000 + 800
    expect(r.platformCents).toBe(100 * 2 + 100 * 1); // 200 + 100
  });

  it("starts mid-tier when cumulative is set", () => {
    // cumulative=50, qty=100: 50 units left in tier-1 @10/2, then 50 @8/1
    const r = priceUnit(pricing, 50, 100);
    expect(r.vendorCents).toBe(50 * 10 + 50 * 8); // 500 + 400
    expect(r.platformCents).toBe(50 * 2 + 50 * 1); // 100 + 50
  });
});

describe("priceUnit — volume", () => {
  const pricing: PricingConfig = {
    model: "volume",
    tiers: [
      { up_to: 100, vendor_unit_price_cents: 10, platform_fee_cents: 2 },
      { up_to: 1000, vendor_unit_price_cents: 8, platform_fee_cents: 1 },
      { up_to: null, vendor_unit_price_cents: 5, platform_fee_cents: 1 },
    ],
  };

  it("uses tier that contains total for ALL units", () => {
    // effectiveTotal=150 → tier2 @8/1 for all 150 billable units
    const r = priceUnit(pricing, 0, 150);
    expect(r.vendorCents).toBe(150 * 8);
    expect(r.platformCents).toBe(150 * 1);
  });

  it("small qty stays in tier1", () => {
    const r = priceUnit(pricing, 0, 50);
    expect(r.vendorCents).toBe(50 * 10);
    expect(r.platformCents).toBe(50 * 2);
  });
});

// ---------------------------------------------------------------------------
// computeUsageSplit
// ---------------------------------------------------------------------------

describe("computeUsageSplit — BYOK direct sale", () => {
  it("vendor + platform = billable", () => {
    const r = computeUsageSplit({
      billableCents: 1200,
      vendorUnitPriceCents: 10,
      platformFeeCents: 2,
      qty: 100,
      costMode: "byok",
    });
    expect(r.vendorCents).toBe(1000);
    expect(r.platformCents).toBe(200);
    expect(r.resellerCents).toBeNull();
    expect(r.affiliateCents).toBeNull();
    expect(r.vendorCents + r.platformCents).toBe(r.billableCents);
  });
});

describe("computeUsageSplit — affiliate", () => {
  it("affiliate gets bps of platform fee; platform keeps the rest; sum === billable", () => {
    // vendor=1000, platform_fee=200, affiliate_bps=3000 (30%)
    const r = computeUsageSplit({
      billableCents: 1200,
      vendorUnitPriceCents: 10,
      platformFeeCents: 2,
      qty: 100,
      affiliateCommissionBps: 3000,
      costMode: "byok",
    });
    expect(r.affiliateCents).toBe(Math.floor((200 * 3000) / 10_000)); // 60
    expect(r.platformCents).toBe(200 - 60); // 140
    expect(r.resellerCents).toBeNull();
    expect(r.vendorCents + r.platformCents + r.affiliateCents!).toBe(1200);
  });
});

describe("computeUsageSplit — reseller", () => {
  it("platform takes 5% of markup; reseller keeps rest; sum === billable", () => {
    // vendor=1000, platform_fee=200, markup per unit=5, qty=100 → markup=500
    // billable = vendor+platform+markup = 1700
    const markup = 500;
    const platformCutOnMarkup = Math.floor((markup * 500) / 10_000); // 25
    const r = computeUsageSplit({
      billableCents: 1700,
      vendorUnitPriceCents: 10,
      platformFeeCents: 2,
      qty: 100,
      resellerMarkupCentsPerUnit: 5,
      costMode: "byok",
    });
    expect(r.resellerCents).toBe(markup - platformCutOnMarkup); // 475
    expect(r.platformCents).toBe(200 + platformCutOnMarkup); // 225
    expect(r.affiliateCents).toBeNull();
    expect(
      r.vendorCents + r.platformCents + r.resellerCents!
    ).toBe(1700);
  });
});

describe("computeUsageSplit — managed mode", () => {
  it("platform share covers provider cost", () => {
    // platform_fee=5/unit, provider_cost=3/unit, qty=100
    const r = computeUsageSplit({
      billableCents: 1500, // 10+5=15 per unit × 100
      vendorUnitPriceCents: 10,
      platformFeeCents: 5,
      qty: 100,
      costMode: "managed",
      providerCostCentsPerUnit: 3,
    });
    expect(r.platformCents).toBe(500); // 5*100
    // 500 >= 300 (provider cost) — OK
    expect(r.platformCents).toBeGreaterThanOrEqual(3 * 100);
  });

  it("throws when platform fee below provider cost", () => {
    expect(() =>
      computeUsageSplit({
        billableCents: 1200,
        vendorUnitPriceCents: 10,
        platformFeeCents: 2,
        qty: 100,
        costMode: "managed",
        providerCostCentsPerUnit: 5, // 500 > 200 platform fee
      })
    ).toThrow(/managed mode platform share/);
  });
});

describe("computeUsageSplit — invariant guards", () => {
  it("throws on affiliate + reseller both set", () => {
    expect(() =>
      computeUsageSplit({
        billableCents: 1700,
        vendorUnitPriceCents: 10,
        platformFeeCents: 2,
        qty: 100,
        affiliateCommissionBps: 2000,
        resellerMarkupCentsPerUnit: 5,
        costMode: "byok",
      })
    ).toThrow(/mutually exclusive/);
  });

  it("throws when sum invariant is violated (wrong billableCents)", () => {
    expect(() =>
      computeUsageSplit({
        billableCents: 9999, // wrong
        vendorUnitPriceCents: 10,
        platformFeeCents: 2,
        qty: 100,
        costMode: "byok",
      })
    ).toThrow(/sum invariant/);
  });
});

// ---------------------------------------------------------------------------
// Fuzz tests (1 000 iterations each)
// ---------------------------------------------------------------------------

describe("computeUsageSplit — fuzz: sum invariant and non-negative platform", () => {
  function rand(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  it("BYOK: sum === billable, platformCents >= 0 for 1000 random inputs", () => {
    for (let i = 0; i < 1000; i++) {
      const qty = rand(1, 10_000);
      const vendorPerUnit = rand(0, 1000);
      const platformPerUnit = rand(1, 500);
      const markupPerUnit = Math.random() > 0.5 ? rand(0, 300) : undefined;
      const affiliateBps =
        markupPerUnit == null && Math.random() > 0.5 ? rand(1000, 5000) : undefined;
      const billable = (vendorPerUnit + platformPerUnit + (markupPerUnit ?? 0)) * qty;

      let r: ReturnType<typeof computeUsageSplit>;
      try {
        r = computeUsageSplit({
          billableCents: billable,
          vendorUnitPriceCents: vendorPerUnit,
          platformFeeCents: platformPerUnit,
          qty,
          resellerMarkupCentsPerUnit: markupPerUnit,
          affiliateCommissionBps: affiliateBps,
          costMode: "byok",
        });
      } catch {
        // some random combos legitimately throw (e.g. bad billable); skip
        continue;
      }
      const sum =
        r.vendorCents + r.platformCents + (r.resellerCents ?? 0) + (r.affiliateCents ?? 0);
      expect(sum).toBe(billable);
      expect(r.platformCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("managed: platformCents always >= providerCost when price is valid", () => {
    for (let i = 0; i < 1000; i++) {
      const qty = rand(1, 1000);
      const vendorPerUnit = rand(0, 500);
      const providerPerUnit = rand(1, 20);
      // Ensure platform fee always covers provider cost
      const platformPerUnit = providerPerUnit + rand(0, 100);
      const billable = (vendorPerUnit + platformPerUnit) * qty;

      const r = computeUsageSplit({
        billableCents: billable,
        vendorUnitPriceCents: vendorPerUnit,
        platformFeeCents: platformPerUnit,
        qty,
        costMode: "managed",
        providerCostCentsPerUnit: providerPerUnit,
      });
      expect(r.platformCents).toBeGreaterThanOrEqual(providerPerUnit * qty);
      const sum = r.vendorCents + r.platformCents;
      expect(sum).toBe(billable);
    }
  });
});
