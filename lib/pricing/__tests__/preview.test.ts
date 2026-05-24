import { describe, it, expect } from "vitest";
import {
  computeStripeFee,
  previewVendorDirect,
  previewAffiliate,
  previewReseller,
  previewBuyer,
  assertSumInvariant,
} from "../preview";

// ── computeStripeFee ─────────────────────────────────────────────────────────
describe("computeStripeFee", () => {
  it("computes 2.9% + $0.30 rounded", () => {
    expect(computeStripeFee(4900)).toBe(172); // $49 → $1.72
    expect(computeStripeFee(7900)).toBe(259); // $79 → $2.59 (round)
    expect(computeStripeFee(100)).toBe(33);   // $1 → $0.33
  });
});

// ── previewVendorDirect ──────────────────────────────────────────────────────
describe("previewVendorDirect", () => {
  it("computes Tier 1 payout at $49 price, $0 MRR", () => {
    const p = previewVendorDirect({ priceCents: 4900, currentNetMrrCents: 0 });
    expect(p.grossCents).toBe(4900);
    expect(p.stripeFeeCents).toBe(172);
    expect(p.netCents).toBe(4728);
    expect(p.cutBps).toBe(1200);
    expect(p.platformCutCents).toBe(567); // floor(4728 * 1200/10000)
    expect(p.vendorCents).toBe(4161);
    expect(p.vendorCents + p.platformCutCents).toBe(p.netCents);
    expect(p.isOverride).toBe(false);
    expect(p.nextTier?.bps).toBe(800);
  });

  it("shows no next tier at Tier 4 ($10k+ MRR)", () => {
    const p = previewVendorDirect({ priceCents: 4900, currentNetMrrCents: 1_500_000 });
    expect(p.cutBps).toBe(300);
    expect(p.nextTier).toBeNull();
  });

  it("respects admin override and hides next tier", () => {
    const p = previewVendorDirect({
      priceCents: 4900,
      currentNetMrrCents: 0,
      overrideBps: 500,
    });
    expect(p.cutBps).toBe(500);
    expect(p.isOverride).toBe(true);
    expect(p.nextTier).toBeNull();
  });

  it("vendor + platform == net (no drift)", () => {
    for (const price of [99, 499, 999, 1999, 4999, 29999]) {
      for (const mrr of [0, 100_000, 300_000, 1_000_000]) {
        const p = previewVendorDirect({ priceCents: price * 100, currentNetMrrCents: mrr });
        expect(p.vendorCents + p.platformCutCents).toBe(p.netCents);
      }
    }
  });
});

// ── previewAffiliate ─────────────────────────────────────────────────────────
describe("previewAffiliate", () => {
  it("clamps vendor commission to affiliate tier cap", () => {
    const p = previewAffiliate({ priceCents: 4900, vendorOfferedBps: 5000, affiliateTierBps: 2000 });
    expect(p.clampedBps).toBe(2000);
    expect(p.affiliateCents).toBe(Math.floor((p.netCents * 2000) / 10_000));
  });

  it("uses vendor rate when lower than tier cap", () => {
    const p = previewAffiliate({ priceCents: 4900, vendorOfferedBps: 2500, affiliateTierBps: 3000 });
    expect(p.clampedBps).toBe(2500);
  });

  it("platform + affiliate + vendor == net", () => {
    for (let i = 0; i < 200; i++) {
      const priceCents = 500 + Math.floor(Math.random() * 49_500);
      const vendorBps = 2000 + Math.floor(Math.random() * 6000);
      const tierBps = [2000, 2500, 3000][Math.floor(Math.random() * 3)];
      const p = previewAffiliate({ priceCents, vendorOfferedBps: vendorBps, affiliateTierBps: tierBps });
      expect(p.platformCutCents + p.affiliateCents + p.vendorCents).toBe(p.netCents);
    }
  });

  it("produces tier projections for all 3 tiers", () => {
    const p = previewAffiliate({ priceCents: 4900, vendorOfferedBps: 5000, affiliateTierBps: 2000 });
    expect(p.tierProjections).toHaveLength(3);
  });
});

// ── previewReseller ──────────────────────────────────────────────────────────
describe("previewReseller", () => {
  it("computes Tier 1 split for $79 sell on $49 floor", () => {
    const p = previewReseller({
      floorCents: 4900,
      sellPriceCents: 7900,
      vendorOpenness: "open_to_resellers",
    });
    expect(p.grossCents).toBe(7900);
    const net = p.netCents;
    const markup = net - 4900;
    expect(p.markupCents).toBe(markup);
    expect(p.tier1.platformCutCents).toBe(Math.floor((markup * 500) / 10_000));
    expect(p.tier1.resellerCents + p.tier1.vendorCents + p.tier1.platformCutCents).toBe(net);
  });

  it("shows Tier 2 comparison when vendor is open_to_wl", () => {
    const p = previewReseller({
      floorCents: 4900,
      sellPriceCents: 7900,
      vendorOpenness: "open_to_wl",
    });
    expect(p.tier2).not.toBeNull();
    expect(p.tier2!.platformCutCents).toBeLessThan(p.tier1.platformCutCents);
    expect(p.tier2!.resellerCents).toBeGreaterThan(p.tier1.resellerCents);
    expect(p.breakEvenSales).toBeGreaterThan(0);
  });

  it("no Tier 2 when vendor is not open_to_wl", () => {
    const p = previewReseller({
      floorCents: 4900,
      sellPriceCents: 7900,
      vendorOpenness: "open_to_resellers",
    });
    expect(p.tier2).toBeNull();
  });

  it("sum invariant for tier1: vendor+platform+reseller==net", () => {
    for (let i = 0; i < 200; i++) {
      const floor = 1000 + Math.floor(Math.random() * 9000);
      const sell = floor + 100 + Math.floor(Math.random() * 10_000);
      const openness = Math.random() > 0.5 ? ("open_to_wl" as const) : ("open_to_resellers" as const);
      const p = previewReseller({ floorCents: floor, sellPriceCents: sell, vendorOpenness: openness });
      expect(p.tier1.resellerCents + p.tier1.vendorCents + p.tier1.platformCutCents).toBe(p.netCents);
      if (p.tier2) {
        expect(p.tier2.resellerCents + p.tier2.vendorCents + p.tier2.platformCutCents).toBe(p.netCents);
      }
    }
  });
});

// ── previewBuyer ─────────────────────────────────────────────────────────────
describe("previewBuyer", () => {
  it("direct: vendor+platform+stripe==gross", () => {
    const p = previewBuyer({ priceCents: 4900, channel: "direct", cutBps: 1200 });
    assertSumInvariant(p);
  });

  it("affiliate: vendor+platform+affiliate+stripe==gross", () => {
    const p = previewBuyer({
      priceCents: 4900,
      channel: "affiliate",
      affiliateCommBps: 2000,
    });
    assertSumInvariant(p);
  });

  it("reseller: vendor+platform+reseller+stripe==gross", () => {
    const p = previewBuyer({
      priceCents: 7900,
      channel: "reseller",
      resellerFloorCents: 4900,
      resellerWlTier: 1,
      vendorOpenness: "open_to_resellers",
    });
    assertSumInvariant(p);
  });

  it("fuzz — all channels, 1000 iterations, sum invariant never breaks", () => {
    const channels = ["direct", "affiliate", "reseller"] as const;
    for (let i = 0; i < 1000; i++) {
      const gross = 100 + Math.floor(Math.random() * 99_900);
      const ch = channels[Math.floor(Math.random() * 3)];
      let p;
      if (ch === "direct") {
        const bps = [1200, 800, 500, 300][Math.floor(Math.random() * 4)];
        p = previewBuyer({ priceCents: gross, channel: "direct", cutBps: bps });
      } else if (ch === "affiliate") {
        const commBps = 2000 + Math.floor(Math.random() * 6001); // [2000, 8000] per DB CHECK
        p = previewBuyer({ priceCents: gross, channel: "affiliate", affiliateCommBps: commBps });
      } else {
        const floor = Math.floor(gross * 0.4);
        const wlTier = Math.random() > 0.5 ? (1 as const) : (2 as const);
        const openness = wlTier === 2 ? ("open_to_wl" as const) : ("open_to_resellers" as const);
        p = previewBuyer({
          priceCents: gross,
          channel: "reseller",
          resellerFloorCents: floor,
          resellerWlTier: wlTier,
          vendorOpenness: openness,
        });
      }
      assertSumInvariant(p);
    }
  });
});
