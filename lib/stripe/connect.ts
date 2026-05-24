import { getStripe } from "./client";
import { createAdminClient } from "@/lib/services/supabase";

export async function getOrCreateConnectAccount(vendorId: string): Promise<string> {
  const admin = createAdminClient();

  // Return existing account if already stored on profile (backward compat)
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

  // Write to profiles (backward compat) AND to the user's personal org (canonical post-#47)
  await admin.from("profiles").update({ stripe_account_id: account.id }).eq("id", vendorId);

  // Update org — look up personal org by owner membership
  const { data: membership } = await admin
    .from("org_members")
    .select("org_id, organizations!inner(type)")
    .eq("user_id", vendorId)
    .eq("organizations.type", "personal")
    .maybeSingle();
  if (membership?.org_id) {
    await admin
      .from("organizations")
      .update({ stripe_account_id: account.id })
      .eq("id", membership.org_id);
  }

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

// Sync reseller's Stripe Connect account branding for Tier 2 white-label.
// Uploads the logo to Stripe Files API (required — Stripe can't reference external URLs)
// then updates branding settings. Idempotent — repeated calls overwrite with latest values.
// Note: branding is per-account, not per-offer. Multiple Tier 2 offers share one branding;
// the most recently upgraded offer's branding wins on Stripe Checkout.
export async function syncResellerConnectBranding(args: {
  resellerStripeAccountId: string;
  logoUrl: string;
  brandColor: string;
  displayName: string;
}): Promise<void> {
  const stripe = getStripe();

  // Download logo bytes from Supabase Storage public URL
  const logoResponse = await fetch(args.logoUrl);
  if (!logoResponse.ok) {
    throw new Error(`Failed to fetch logo from ${args.logoUrl}: ${logoResponse.status}`);
  }
  const logoBuffer = Buffer.from(await logoResponse.arrayBuffer());

  // Upload to Stripe Files (scoped to the connected account)
  const file = await stripe.files.create(
    {
      purpose: "business_logo",
      file: {
        data: logoBuffer,
        name: "logo.png",
        type: "application/octet-stream",
      },
    },
    { stripeAccount: args.resellerStripeAccountId }
  );

  // Update connected account branding
  await stripe.accounts.update(args.resellerStripeAccountId, {
    settings: {
      branding: {
        logo: file.id,
        primary_color: args.brandColor,
      },
    },
    business_profile: { name: args.displayName },
  });
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

  // Dual-write: profiles (backward compat) + organizations (canonical post-#47)
  const { error } = await admin
    .from("profiles")
    .update({ charges_enabled, payouts_enabled })
    .eq("id", vendorId);
  if (error) throw new Error(`Failed to sync Connect status on profiles: ${error.message}`);

  await admin
    .from("organizations")
    .update({ charges_enabled, payouts_enabled })
    .eq("stripe_account_id", accountId);

  return { charges_enabled, payouts_enabled };
}
