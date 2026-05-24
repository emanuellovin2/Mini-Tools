import { getStripe } from "./client";
import { createAdminClient } from "@/lib/services/supabase";

// ── Affiliate split (SPEC §4a, #18) ─────────────────────────────────────────
// Platform takes 5% flat; affiliate gets their commission %; vendor keeps the rest.
// affiliateCommissionBps must be in [2000, 8000] (enforced by DB CHECK).
export function computeAffiliateSplit(
  netAmountCents: number,
  affiliateCommissionBps: number
): { vendorShareCents: number; platformFeeCents: number; affiliateShareCents: number } {
  const platformFeeCents = Math.floor((netAmountCents * 500) / 10_000);
  const affiliateShareCents = Math.floor((netAmountCents * affiliateCommissionBps) / 10_000);
  const vendorShareCents = netAmountCents - platformFeeCents - affiliateShareCents;
  if (vendorShareCents < 0)
    throw new Error(
      `computeAffiliateSplit: negative vendor share (net=${netAmountCents}, affiliateBps=${affiliateCommissionBps})`
    );
  return { vendorShareCents, platformFeeCents, affiliateShareCents };
}

// Affiliate commission tier based on current active MRR they have generated.
// Tier boundaries: <$5k → 20%, $5k–$20k → 25%, $20k+ → 30%.
export function getAffiliateCommissionBps(affiliateActiveMrrCents: number): number {
  if (affiliateActiveMrrCents >= 2_000_000) return 3000; // $20k+ → 30%
  if (affiliateActiveMrrCents >= 500_000) return 2500;   // $5k+  → 25%
  return 2000;                                            // standard → 20%
}

// Returns the active cut_bps for a vendor.
// Precedence: (1) profiles.vendor_cut_bps_override (admin-set, audited)
//             (2) latest vendor_billing.cut_bps ≤ today (auto-tier)
//             (3) 1200 default (Tier 1) — SPEC §8
export async function getVendorCutBps(vendorId: string): Promise<number> {
  const admin = createAdminClient();

  // 1. Admin override takes precedence — bypasses tier entirely
  const { data: profile } = await admin
    .from("profiles")
    .select("vendor_cut_bps_override")
    .eq("id", vendorId)
    .maybeSingle();

  if (profile?.vendor_cut_bps_override != null) {
    return profile.vendor_cut_bps_override;
  }

  // 2. Auto-tier from latest vendor_billing row
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await admin
    .from("vendor_billing")
    .select("cut_bps")
    .eq("vendor_id", vendorId)
    .lte("period_start", today)
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  // 3. Default — Tier 1
  return data?.cut_bps ?? 1_200;
}

// Integer-safe vendor share. For direct sales, computes floor(amount * (10000 - cutBps) / 10000).
// For affiliate sales, pass overrideVendorShareCents (from computeAffiliateSplit) to skip computation.
export async function transferVendorShare({
  invoiceId,
  amountCents,
  vendorId,
  stripeAccountId,
  cutBps,
  overrideVendorShareCents,
}: {
  invoiceId: string;
  amountCents: number;
  vendorId: string;
  stripeAccountId: string;
  cutBps: number;
  overrideVendorShareCents?: number;
}): Promise<{ transferId: string; vendorShareCents: number }> {
  const vendorShareCents = overrideVendorShareCents ?? Math.floor((amountCents * (10_000 - cutBps)) / 10_000);
  const stripe = getStripe();
  const transfer = await stripe.transfers.create(
    {
      amount: vendorShareCents,
      currency: "usd",
      destination: stripeAccountId,
      transfer_group: `invoice_${invoiceId}`,
      metadata: { invoice_id: invoiceId, vendor_id: vendorId },
    },
    { idempotencyKey: `transfer:invoice_${invoiceId}:vendor_${vendorId}` }
  );
  return { transferId: transfer.id, vendorShareCents };
}

// Transfer the affiliate's pre-computed share (from computeAffiliateSplit).
export async function transferAffiliateShare({
  invoiceId,
  affiliateShareCents,
  affiliateId,
  stripeAccountId,
}: {
  invoiceId: string;
  affiliateShareCents: number;
  affiliateId: string;
  stripeAccountId: string;
}): Promise<{ transferId: string; affiliateShareCents: number }> {
  const stripe = getStripe();
  const transfer = await stripe.transfers.create(
    {
      amount: affiliateShareCents,
      currency: "usd",
      destination: stripeAccountId,
      transfer_group: `invoice_${invoiceId}`,
      metadata: { invoice_id: invoiceId, affiliate_id: affiliateId },
    },
    { idempotencyKey: `transfer:invoice_${invoiceId}:affiliate_${affiliateId}` }
  );
  return { transferId: transfer.id, affiliateShareCents };
}

// ── Reseller money split (SPEC §4b, #29) ────────────────────────────────────
// WL kickback rate: vendor receives 1/3 of platform's reseller-side commission on open_to_wl sales.
// Exposed as an exported const for tunability — DO NOT inline.
export const VENDOR_WL_KICKBACK_BPS = 3333; // 33.33% (one third)

export interface ResellerSplit {
  vendorShareCents: number;    // = floor + kickback (or = amount in Stripe-fee edge case)
  platformCutCents: number;    // = platformCommission − kickback
  resellerShareCents: number;  // = amount − vendor − platform (residual; absorbs rounding)
}

// Single-stream split with optional WL kickback to vendor.
//
// Tier 1: platform takes 5% of markup; Tier 2: platform takes 2.5% of markup.
// On open_to_wl, platform redistributes 1/3 of its commission to vendor as kickback.
// Reseller's share is the residual — it absorbs all rounding, so vendor + platform + reseller === amount always.
//
// Stripe-fee edge: when net < floor on tiny invoices (#17), vendor gets full amount, others 0.
// Offer validity (sell_price >= floor) is enforced at offer creation; the edge case only arises
// because Stripe processing fees can push the distributable net below the gross floor.
export function computeResellerSplit(args: {
  amountCents: number;
  vendorFloorCents: number;
  wlTier: 1 | 2;
  vendorOpenness: "open_to_resellers" | "open_to_wl";
}): ResellerSplit {
  const { amountCents, vendorFloorCents, wlTier, vendorOpenness } = args;

  // Stripe-fee edge: net < floor — give 100% to vendor, others get 0.
  if (amountCents < vendorFloorCents) {
    return { vendorShareCents: amountCents, platformCutCents: 0, resellerShareCents: 0 };
  }

  // Invariant guard: Tier 2 sales require vendor opted into WL.
  if (wlTier === 2 && vendorOpenness !== "open_to_wl") {
    throw new Error(
      `invariant: Tier 2 sale requires vendorOpenness=open_to_wl, got ${vendorOpenness}`
    );
  }

  const markup = amountCents - vendorFloorCents;
  const resellerSideBps = wlTier === 2 ? 250 : 500; // 2.5% Tier 2, 5% Tier 1

  const platformCommission = Math.floor((markup * resellerSideBps) / 10_000);

  const vendorKickback =
    vendorOpenness === "open_to_wl"
      ? Math.floor((platformCommission * VENDOR_WL_KICKBACK_BPS) / 10_000)
      : 0;

  const vendorShare = vendorFloorCents + vendorKickback;
  const platformCut = platformCommission - vendorKickback;
  const resellerShare = amountCents - vendorShare - platformCut;

  if (resellerShare < 0) {
    throw new Error(
      `computeResellerSplit: negative reseller share (amount=${amountCents}, vendor=${vendorShare}, platform=${platformCut})`
    );
  }
  if (platformCut < 0) {
    throw new Error(`computeResellerSplit: negative platform cut (kickback > commission)`);
  }
  if (vendorShare + platformCut + resellerShare !== amountCents) {
    throw new Error(
      `computeResellerSplit: sum invariant broken (sum=${vendorShare + platformCut + resellerShare}, expected=${amountCents})`
    );
  }

  return { vendorShareCents: vendorShare, platformCutCents: platformCut, resellerShareCents: resellerShare };
}

// Transfer the vendor's share (floor + optional WL kickback) for a reseller-sold invoice.
// Callers must pass the vendorShareCents from computeResellerSplit — no internal recomputation.
export async function transferResellerVendorFloor({
  invoiceId,
  vendorShareCents,
  vendorId,
  stripeAccountId,
}: {
  invoiceId: string;
  vendorShareCents: number;
  vendorId: string;
  stripeAccountId: string;
}): Promise<{ transferId: string }> {
  const stripe = getStripe();
  const transfer = await stripe.transfers.create(
    {
      amount: vendorShareCents,
      currency: "usd",
      destination: stripeAccountId,
      transfer_group: `invoice_${invoiceId}`,
      metadata: { invoice_id: invoiceId, vendor_id: vendorId, type: "vendor_share" },
    },
    { idempotencyKey: `transfer:invoice_${invoiceId}:vendor_floor:${vendorId}` }
  );
  return { transferId: transfer.id };
}

// Transfer the reseller's markup share for a reseller-sold invoice.
export async function transferResellerShare({
  invoiceId,
  resellerShareCents,
  resellerId,
  stripeAccountId,
}: {
  invoiceId: string;
  resellerShareCents: number;
  resellerId: string;
  stripeAccountId: string;
}): Promise<{ transferId: string }> {
  const stripe = getStripe();
  const transfer = await stripe.transfers.create(
    {
      amount: resellerShareCents,
      currency: "usd",
      destination: stripeAccountId,
      transfer_group: `invoice_${invoiceId}`,
      metadata: { invoice_id: invoiceId, reseller_id: resellerId, type: "reseller_markup" },
    },
    { idempotencyKey: `transfer:invoice_${invoiceId}:reseller:${resellerId}` }
  );
  return { transferId: transfer.id };
}

// Reverse all transfers in the transfer_group for this invoice.
// Used for disputes (outcome=lost) — all parties absorb the loss.
// Idempotent: skips already-reversed transfers.
export async function reverseTransfers({
  invoiceId,
  chargeId,
}: {
  invoiceId: string;
  chargeId: string;
}): Promise<void> {
  const stripe = getStripe();
  const transfers = await stripe.transfers.list({ transfer_group: `invoice_${invoiceId}` });
  for (const transfer of transfers.data) {
    if (transfer.reversed) continue;
    await stripe.transfers.createReversal(
      transfer.id,
      { metadata: { charge_id: chargeId, invoice_id: invoiceId } },
      { idempotencyKey: `reversal:transfer_${transfer.id}:charge_${chargeId}` }
    );
  }
}

// Reverse only the vendor transfer(s) in the group — used for voluntary refunds.
// Affiliate and reseller shares are NOT reversed: the vendor absorbs the cost.
// Vendor transfers are identified by having `vendor_id` in their metadata.
// Idempotent: skips already-reversed transfers.
export async function reverseVendorTransfers({
  invoiceId,
  chargeId,
}: {
  invoiceId: string;
  chargeId: string;
}): Promise<void> {
  const stripe = getStripe();
  const transfers = await stripe.transfers.list({ transfer_group: `invoice_${invoiceId}` });
  for (const transfer of transfers.data) {
    if (transfer.reversed) continue;
    if (!transfer.metadata?.vendor_id) continue; // skip affiliate and reseller markup transfers
    await stripe.transfers.createReversal(
      transfer.id,
      { metadata: { charge_id: chargeId, invoice_id: invoiceId, policy: "vendor_only" } },
      { idempotencyKey: `reversal:vendor:transfer_${transfer.id}:charge_${chargeId}` }
    );
  }
}
