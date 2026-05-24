// Pure, side-effect-free money math for usage-based billing.
// All inputs/outputs in integer cents or bps. Throws on invariant violations.

// ---------------------------------------------------------------------------
// Pricing config types
// ---------------------------------------------------------------------------

export interface PricingTier {
  /** Max units this tier applies to. null = unbounded (last tier must be null). */
  up_to: number | null;
  vendor_unit_price_cents: number;
  platform_fee_cents: number;
}

export interface PricingConfig {
  model: "flat" | "tiered" | "volume";
  tiers: PricingTier[];
  /** Units consumed at zero cost before billing begins. Defaults to 0. */
  included_allowance?: number;
  /** Minimum total charge per call (in cents). Optional. */
  minimum_commitment_cents?: number;
}

export interface PriceUnitResult {
  vendorCents: number;
  platformCents: number;
}

/**
 * Compute the per-call cost for `qty` units, given `cumulativeQty` already used
 * in this period (for tiered/volume: determines which tier we start in).
 *
 * - flat:   single tier rate for all units
 * - tiered: waterfall — different rate per tier slice (like Stripe)
 * - volume: the tier that contains the TOTAL determines rate for ALL units
 *
 * `included_allowance` subtracts free units before pricing applies.
 * `minimum_commitment_cents` raises the result if it's below the floor.
 */
export function priceUnit(
  pricing: PricingConfig,
  cumulativeQty: number,
  qty: number
): PriceUnitResult {
  if (qty <= 0) throw new Error("priceUnit: qty must be > 0");
  if (pricing.tiers.length === 0) throw new Error("priceUnit: tiers must not be empty");

  const allowance = pricing.included_allowance ?? 0;

  // Units already consumed within the allowance window
  const alreadyFree = Math.min(cumulativeQty, allowance);
  const freeRemaining = Math.max(0, allowance - alreadyFree);
  const billableQty = Math.max(0, qty - freeRemaining);

  if (billableQty === 0) {
    return { vendorCents: 0, platformCents: 0 };
  }

  // Effective cumulative start for pricing (after allowance)
  const effectiveCumulative = Math.max(0, cumulativeQty - allowance);
  const effectiveTotal = effectiveCumulative + billableQty;

  let vendorCents = 0;
  let platformCents = 0;

  if (pricing.model === "flat") {
    const tier = pricing.tiers[0];
    vendorCents = tier.vendor_unit_price_cents * billableQty;
    platformCents = tier.platform_fee_cents * billableQty;
  } else if (pricing.model === "volume") {
    // Find the tier that contains effectiveTotal
    const tier = findVolumeTier(pricing.tiers, effectiveTotal);
    vendorCents = tier.vendor_unit_price_cents * billableQty;
    platformCents = tier.platform_fee_cents * billableQty;
  } else {
    // tiered: waterfall — charge per-tier slice
    let remaining = billableQty;
    let cursor = effectiveCumulative;

    for (const tier of pricing.tiers) {
      if (remaining <= 0) break;
      const tierMax = tier.up_to ?? Infinity;
      const sliceStart = cursor;
      const sliceEnd = Math.min(tierMax, sliceStart + remaining);
      const sliceQty = sliceEnd - sliceStart;
      if (sliceQty <= 0) {
        cursor = tierMax;
        continue;
      }
      vendorCents += tier.vendor_unit_price_cents * sliceQty;
      platformCents += tier.platform_fee_cents * sliceQty;
      remaining -= sliceQty;
      cursor = sliceEnd;
    }
  }

  // Apply minimum commitment floor
  if (pricing.minimum_commitment_cents != null) {
    const total = vendorCents + platformCents;
    if (total < pricing.minimum_commitment_cents) {
      // Distribute the shortfall proportionally (or all to platform if vendor is 0)
      const delta = pricing.minimum_commitment_cents - total;
      platformCents += delta;
    }
  }

  return { vendorCents, platformCents };
}

function findVolumeTier(tiers: PricingTier[], total: number): PricingTier {
  for (const tier of tiers) {
    if (tier.up_to == null || total <= tier.up_to) return tier;
  }
  return tiers[tiers.length - 1];
}

// ---------------------------------------------------------------------------
// Usage split (per-event money distribution)
// ---------------------------------------------------------------------------

export interface UsageSplitArgs {
  billableCents: number;
  vendorUnitPriceCents: number;
  platformFeeCents: number;
  qty: number;
  /** Reseller markup per unit (only if reseller-attributed). */
  resellerMarkupCentsPerUnit?: number;
  /** Affiliate commission bps applied to platform fee (only if affiliate-attributed). */
  affiliateCommissionBps?: number;
  costMode: "byok" | "managed";
  /** Required for managed mode: platform's provider cost per unit. */
  providerCostCentsPerUnit?: number;
}

export interface UsageSplitResult {
  billableCents: number;
  vendorCents: number;
  /** Net platform revenue after affiliate and after reseller platform cut is added. */
  platformCents: number;
  /** Net reseller share (null if no reseller). */
  resellerCents: number | null;
  /** Affiliate share (null if no affiliate). */
  affiliateCents: number | null;
}

/**
 * Compute the four-way split for one usage billing event.
 *
 * Invariants enforced (throws on violation):
 *  1. vendorCents + platformCents + resellerCents + affiliateCents === billableCents
 *  2. platformCents >= 0
 *  3. managed mode: platformCents >= providerCostCentsPerUnit * qty
 *  4. affiliate and reseller are mutually exclusive
 */
export function computeUsageSplit(args: UsageSplitArgs): UsageSplitResult {
  const {
    billableCents,
    vendorUnitPriceCents,
    platformFeeCents,
    qty,
    resellerMarkupCentsPerUnit,
    affiliateCommissionBps,
    costMode,
    providerCostCentsPerUnit,
  } = args;

  if (affiliateCommissionBps != null && resellerMarkupCentsPerUnit != null) {
    throw new Error(
      "computeUsageSplit: affiliate and reseller attribution are mutually exclusive"
    );
  }

  const rawVendor = vendorUnitPriceCents * qty;
  const rawPlatformFee = platformFeeCents * qty;
  const rawMarkup = resellerMarkupCentsPerUnit != null ? resellerMarkupCentsPerUnit * qty : 0;

  // Platform takes 5% of reseller markup (same bps as subscription reseller Tier 1)
  const resellerPlatformCut =
    rawMarkup > 0 ? Math.floor((rawMarkup * 500) / 10_000) : 0;

  const affiliateCents =
    affiliateCommissionBps != null
      ? Math.floor((rawPlatformFee * affiliateCommissionBps) / 10_000)
      : null;

  // Platform net = gross fee - affiliate commission + reseller platform cut
  const platformCents =
    rawPlatformFee -
    (affiliateCents ?? 0) +
    resellerPlatformCut;

  const resellerCents = rawMarkup > 0 ? rawMarkup - resellerPlatformCut : null;

  // Managed mode: platform must cover provider cost
  if (costMode === "managed" && providerCostCentsPerUnit != null) {
    const totalProviderCost = providerCostCentsPerUnit * qty;
    if (platformCents < totalProviderCost) {
      throw new Error(
        `computeUsageSplit: managed mode platform share (${platformCents}¢) cannot cover provider cost (${totalProviderCost}¢) — raise platform_fee_cents`
      );
    }
  }

  if (platformCents < 0) {
    throw new Error(
      `computeUsageSplit: negative platform share (${platformCents}¢)`
    );
  }

  const sum =
    rawVendor + platformCents + (resellerCents ?? 0) + (affiliateCents ?? 0);

  if (sum !== billableCents) {
    throw new Error(
      `computeUsageSplit: sum invariant broken — got ${sum}, expected billable=${billableCents}`
    );
  }

  return {
    billableCents,
    vendorCents: rawVendor,
    platformCents,
    resellerCents,
    affiliateCents,
  };
}
