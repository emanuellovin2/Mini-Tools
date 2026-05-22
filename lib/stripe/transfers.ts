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
