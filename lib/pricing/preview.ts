import { computeTier } from "@/lib/stripe/billing";
import { computeResellerSplit, VENDOR_WL_KICKBACK_BPS } from "@/lib/stripe/transfers";

// Standard Stripe card fee: 2.9% + $0.30
export function computeStripeFee(grossCents: number): number {
  return Math.round((grossCents * 29) / 1000) + 30;
}

// ── Vendor tier table ────────────────────────────────────────────────────────
const VENDOR_TIERS = [
  { tier: 1 as const, bps: 1200, thresholdCents: 0, label: "$0" },
  { tier: 2 as const, bps: 800, thresholdCents: 100_000, label: "$1k" },
  { tier: 3 as const, bps: 500, thresholdCents: 300_000, label: "$3k" },
  { tier: 4 as const, bps: 300, thresholdCents: 1_000_000, label: "$10k+" },
];

export interface VendorDirectPreview {
  grossCents: number;
  stripeFeeCents: number;
  netCents: number;
  cutBps: number;
  platformCutCents: number;
  vendorCents: number;
  isOverride: boolean;
  nextTier: {
    bps: number;
    thresholdCents: number;
    label: string;
    vendorCents: number;
  } | null;
}

export function previewVendorDirect({
  priceCents,
  currentNetMrrCents,
  overrideBps,
}: {
  priceCents: number;
  currentNetMrrCents: number;
  overrideBps?: number | null;
}): VendorDirectPreview {
  const gross = priceCents;
  const fee = computeStripeFee(gross);
  const net = Math.max(0, gross - fee);

  const { tier } = computeTier(currentNetMrrCents);
  const autoBps = VENDOR_TIERS.find((t) => t.tier === tier)!.bps;
  const isOverride = overrideBps != null;
  const cutBps = isOverride ? overrideBps : autoBps;

  const platformCut = Math.floor((net * cutBps) / 10_000);
  const vendor = net - platformCut;

  let nextTier: VendorDirectPreview["nextTier"] = null;
  if (!isOverride) {
    const nextData = VENDOR_TIERS.find((t) => t.tier === tier + 1);
    if (nextData) {
      const nextPlatformCut = Math.floor((net * nextData.bps) / 10_000);
      nextTier = {
        bps: nextData.bps,
        thresholdCents: nextData.thresholdCents,
        label: nextData.label,
        vendorCents: net - nextPlatformCut,
      };
    }
  }

  return {
    grossCents: gross,
    stripeFeeCents: fee,
    netCents: net,
    cutBps,
    platformCutCents: platformCut,
    vendorCents: vendor,
    isOverride,
    nextTier,
  };
}

// ── Affiliate preview ────────────────────────────────────────────────────────
// vendorOfferedBps: app.affiliate_commission_bps (vendor-set, 2000–8000)
// affiliateTierBps: affiliate's current MRR-tier cap (2000 / 2500 / 3000)
// Actual earnings = computeAffiliateSplit with min(vendorOffered, tierCap)
export interface AffiliatePreview {
  grossCents: number;
  stripeFeeCents: number;
  netCents: number;
  platformCutCents: number;
  affiliateCents: number;
  vendorCents: number;
  clampedBps: number;
  vendorOfferedBps: number;
  affiliateTierBps: number;
  tierProjections: Array<{
    tierBps: number;
    thresholdLabel: string;
    affiliateCents: number;
  }>;
}

export function previewAffiliate({
  priceCents,
  vendorOfferedBps,
  affiliateTierBps,
}: {
  priceCents: number;
  vendorOfferedBps: number;
  affiliateTierBps: number;
}): AffiliatePreview {
  const gross = priceCents;
  const fee = computeStripeFee(gross);
  const net = Math.max(0, gross - fee);

  const clampedBps = Math.min(vendorOfferedBps, affiliateTierBps);
  const platformCut = Math.floor((net * 500) / 10_000); // 5% flat
  const affiliateShare = Math.floor((net * clampedBps) / 10_000);
  const vendorShare = net - platformCut - affiliateShare;

  const AFFILIATE_TIERS = [
    { tierBps: 2000, thresholdLabel: "Tier 1 ($0+ MRR)" },
    { tierBps: 2500, thresholdLabel: "Tier 2 ($5k+ MRR)" },
    { tierBps: 3000, thresholdLabel: "Tier 3 ($20k+ MRR)" },
  ];

  const tierProjections = AFFILIATE_TIERS.map(({ tierBps, thresholdLabel }) => ({
    tierBps,
    thresholdLabel,
    affiliateCents: Math.floor((net * Math.min(vendorOfferedBps, tierBps)) / 10_000),
  }));

  return {
    grossCents: gross,
    stripeFeeCents: fee,
    netCents: net,
    platformCutCents: platformCut,
    affiliateCents: affiliateShare,
    vendorCents: vendorShare,
    clampedBps,
    vendorOfferedBps,
    affiliateTierBps,
    tierProjections,
  };
}

// ── Reseller preview ─────────────────────────────────────────────────────────
export interface ResellerPreview {
  grossCents: number;
  stripeFeeCents: number;
  netCents: number;
  vendorFloorCents: number;
  markupCents: number;
  tier1: { platformCutCents: number; resellerCents: number; vendorCents: number };
  tier2: { platformCutCents: number; resellerCents: number; vendorCents: number } | null;
  breakEvenSales: number | null;
}

export function previewReseller({
  floorCents,
  sellPriceCents,
  vendorOpenness,
}: {
  floorCents: number;
  sellPriceCents: number;
  vendorOpenness: "closed" | "open_to_resellers" | "open_to_wl";
}): ResellerPreview {
  const gross = sellPriceCents;
  const fee = computeStripeFee(gross);
  const net = Math.max(0, gross - fee);
  const markup = Math.max(0, net - floorCents);

  const safeOpenness =
    vendorOpenness === "open_to_wl" ? ("open_to_wl" as const) : ("open_to_resellers" as const);

  let t1: ResellerPreview["tier1"];
  if (net < floorCents) {
    t1 = { platformCutCents: 0, resellerCents: 0, vendorCents: net };
  } else {
    const s = computeResellerSplit({
      amountCents: net,
      vendorFloorCents: floorCents,
      wlTier: 1,
      vendorOpenness: safeOpenness,
    });
    t1 = {
      platformCutCents: s.platformCutCents,
      resellerCents: s.resellerShareCents,
      vendorCents: s.vendorShareCents,
    };
  }

  let tier2: ResellerPreview["tier2"] = null;
  if (vendorOpenness === "open_to_wl" && net >= floorCents) {
    const s = computeResellerSplit({
      amountCents: net,
      vendorFloorCents: floorCents,
      wlTier: 2,
      vendorOpenness: "open_to_wl",
    });
    tier2 = {
      platformCutCents: s.platformCutCents,
      resellerCents: s.resellerShareCents,
      vendorCents: s.vendorShareCents,
    };
  }

  let breakEvenSales: number | null = null;
  if (tier2 && t1.resellerCents > 0) {
    const gainPerSale = tier2.resellerCents - t1.resellerCents;
    if (gainPerSale > 0) {
      breakEvenSales = Math.ceil(2900 / gainPerSale); // $29/mo Tier 2 upgrade
    }
  }

  return {
    grossCents: gross,
    stripeFeeCents: fee,
    netCents: net,
    vendorFloorCents: floorCents,
    markupCents: markup,
    tier1: t1,
    tier2,
    breakEvenSales,
  };
}

// ── Buyer preview ────────────────────────────────────────────────────────────
export interface BuyerPreview {
  grossCents: number;
  stripeFeeCents: number;
  netCents: number;
  vendorCents: number;
  platformCents: number;
  affiliateCents: number | null;
  resellerCents: number | null;
}

export function previewBuyer({
  priceCents,
  channel,
  cutBps,
  affiliateCommBps,
  resellerFloorCents,
  resellerWlTier,
  vendorOpenness,
}: {
  priceCents: number;
  channel: "direct" | "affiliate" | "reseller";
  cutBps?: number;
  affiliateCommBps?: number;
  resellerFloorCents?: number;
  resellerWlTier?: 1 | 2;
  vendorOpenness?: "open_to_resellers" | "open_to_wl";
}): BuyerPreview {
  const gross = priceCents;
  const fee = computeStripeFee(gross);
  const net = Math.max(0, gross - fee);

  if (channel === "affiliate" && affiliateCommBps != null) {
    const platformCut = Math.floor((net * 500) / 10_000);
    const affiliateShare = Math.floor((net * affiliateCommBps) / 10_000);
    const vendorShare = net - platformCut - affiliateShare;
    return {
      grossCents: gross,
      stripeFeeCents: fee,
      netCents: net,
      vendorCents: vendorShare,
      platformCents: platformCut,
      affiliateCents: affiliateShare,
      resellerCents: null,
    };
  }

  if (
    channel === "reseller" &&
    resellerFloorCents != null &&
    resellerWlTier != null &&
    vendorOpenness != null
  ) {
    if (net >= resellerFloorCents) {
      const s = computeResellerSplit({
        amountCents: net,
        vendorFloorCents: resellerFloorCents,
        wlTier: resellerWlTier,
        vendorOpenness,
      });
      return {
        grossCents: gross,
        stripeFeeCents: fee,
        netCents: net,
        vendorCents: s.vendorShareCents,
        platformCents: s.platformCutCents,
        affiliateCents: null,
        resellerCents: s.resellerShareCents,
      };
    }
    return {
      grossCents: gross,
      stripeFeeCents: fee,
      netCents: net,
      vendorCents: net,
      platformCents: 0,
      affiliateCents: null,
      resellerCents: 0,
    };
  }

  // Direct
  const bps = cutBps ?? 1200;
  const platformCut = Math.floor((net * bps) / 10_000);
  const vendorShare = net - platformCut;
  return {
    grossCents: gross,
    stripeFeeCents: fee,
    netCents: net,
    vendorCents: vendorShare,
    platformCents: platformCut,
    affiliateCents: null,
    resellerCents: null,
  };
}

// ── Sum invariant helper (used in tests) ─────────────────────────────────────
export function assertSumInvariant(preview: BuyerPreview): void {
  const sum =
    preview.vendorCents +
    preview.platformCents +
    (preview.affiliateCents ?? 0) +
    (preview.resellerCents ?? 0) +
    preview.stripeFeeCents;
  if (sum !== preview.grossCents) {
    throw new Error(
      `sum invariant: vendor(${preview.vendorCents}) + platform(${preview.platformCents}) + affiliate(${preview.affiliateCents}) + reseller(${preview.resellerCents}) + stripe(${preview.stripeFeeCents}) = ${sum} ≠ gross(${preview.grossCents})`
    );
  }
}
