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

// ── Reseller money split (SPEC §4b, §11) ────────────────────────────────────
// `availableCents` is the amount actually distributable (net of Stripe fees at webhook time,
// or gross sell-price at modelling time — same math). Vendor always gets their full floor;
// platform takes 5% of the remaining markup; reseller keeps the other 95%.
//
// Offer validity (sell_price >= vendor_floor) is enforced at offer creation in
// services/reseller.ts. At webhook time, however, Stripe processing fees can push the
// distributable net below the gross floor — when that happens, the vendor still receives
// their full floor and the platform absorbs the deficit (markup share = 0 for both
// platform and reseller). Stripe Connect settles transfers against the platform's
// global balance, so a single thin charge is covered by accumulated balance.
export function computeResellerSplit(
  availableCents: number,
  vendorFloorCents: number
): { vendorShareCents: number; platformFeeCents: number; resellerShareCents: number } {
  const markup = availableCents - vendorFloorCents;
  if (markup <= 0) {
    return { vendorShareCents: vendorFloorCents, platformFeeCents: 0, resellerShareCents: 0 };
  }
  const platformFeeCents = Math.floor((markup * 500) / 10_000);
  const resellerShareCents = markup - platformFeeCents;
  return { vendorShareCents: vendorFloorCents, platformFeeCents, resellerShareCents };
}

// Transfer the vendor's fixed floor amount for a reseller-sold invoice.
export async function transferResellerVendorFloor({
  invoiceId,
  vendorFloorCents,
  vendorId,
  stripeAccountId,
}: {
  invoiceId: string;
  vendorFloorCents: number;
  vendorId: string;
  stripeAccountId: string;
}): Promise<{ transferId: string }> {
  const stripe = getStripe();
  const transfer = await stripe.transfers.create(
    {
      amount: vendorFloorCents,
      currency: "usd",
      destination: stripeAccountId,
      transfer_group: `invoice_${invoiceId}`,
      metadata: { invoice_id: invoiceId, vendor_id: vendorId, type: "vendor_floor" },
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
