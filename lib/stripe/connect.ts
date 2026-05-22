import { getStripe } from "./client";
import { createAdminClient } from "@/lib/services/supabase";

export async function getOrCreateConnectAccount(vendorId: string): Promise<string> {
  const admin = createAdminClient();

  // Return existing account if already stored
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", vendorId)
    .single();

  if (profile?.stripe_account_id) return profile.stripe_account_id;

  const stripe = getStripe();
  const account = await stripe.accounts.create(
    { type: "express", capabilities: { card_payments: { requested: true }, transfers: { requested: true } } },
    { idempotencyKey: `acct_create:vendor_${vendorId}` }
  );

  const { error } = await admin
    .from("profiles")
    .update({ stripe_account_id: account.id })
    .eq("id", vendorId);
  if (error) throw new Error(`Failed to store stripe_account_id: ${error.message}`);

  return account.id;
}

export async function createOnboardingLink(
  accountId: string,
  returnUrl: string,
  refreshUrl: string
): Promise<string> {
  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: accountId,
    return_url: returnUrl,
    refresh_url: refreshUrl,
    type: "account_onboarding",
  });
  return link.url;
}

export async function syncConnectStatus(
  vendorId: string,
  accountId: string
): Promise<{ charges_enabled: boolean; payouts_enabled: boolean }> {
  const stripe = getStripe();
  const account = await stripe.accounts.retrieve(accountId);

  const charges_enabled = account.charges_enabled ?? false;
  const payouts_enabled = account.payouts_enabled ?? false;

  const admin = createAdminClient();
  const { error } = await admin
    .from("profiles")
    .update({ charges_enabled, payouts_enabled })
    .eq("id", vendorId);
  if (error) throw new Error(`Failed to sync Connect status: ${error.message}`);

  return { charges_enabled, payouts_enabled };
}
