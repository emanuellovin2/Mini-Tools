import { getStripe } from "./client";
import { createAdminClient } from "@/lib/services/supabase";

// Returns the active cut_bps for a vendor.
// Defaults to Tier 1 (2000 bps = 20%) when no vendor_billing row exists — SPEC §8.
export async function getVendorCutBps(vendorId: string): Promise<number> {
  const admin = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await admin
    .from("vendor_billing")
    .select("cut_bps")
    .eq("vendor_id", vendorId)
    .lte("period_start", today)
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.cut_bps ?? 2000;
}

// Integer-safe vendor share: floor(amount * (10000 - cutBps) / 10000)
export async function transferVendorShare({
  invoiceId,
  amountCents,
  vendorId,
  stripeAccountId,
  cutBps,
}: {
  invoiceId: string;
  amountCents: number;
  vendorId: string;
  stripeAccountId: string;
  cutBps: number;
}): Promise<{ transferId: string; vendorShareCents: number }> {
  const vendorShareCents = Math.floor((amountCents * (10_000 - cutBps)) / 10_000);
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

// Affiliate earns 50% of the platform's tier cut: amount × cutBps / 20_000
export async function transferAffiliateShare({
  invoiceId,
  amountCents,
  affiliateId,
  stripeAccountId,
  cutBps,
}: {
  invoiceId: string;
  amountCents: number;
  affiliateId: string;
  stripeAccountId: string;
  cutBps: number;
}): Promise<{ transferId: string; affiliateShareCents: number }> {
  const affiliateShareCents = Math.floor((amountCents * cutBps) / 20_000);
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
// buyer pays sell_price; vendor gets fixed floor; platform takes 5%; reseller keeps the rest.
// Integer-safe. Throws if resellerShareCents ≤ 0 (offer should have been rejected at creation).
export function computeResellerSplit(
  amountCents: number,
  vendorFloorCents: number
): { vendorShareCents: number; platformFeeCents: number; resellerShareCents: number } {
  const platformFeeCents = Math.floor((amountCents * 500) / 10_000);
  const resellerShareCents = amountCents - vendorFloorCents - platformFeeCents;
  if (resellerShareCents < 0)
    throw new Error(
      `computeResellerSplit: negative reseller share (amount=${amountCents}, floor=${vendorFloorCents})`
    );
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
