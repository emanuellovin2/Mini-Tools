import { createAdminClient } from "@/lib/services/supabase";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import type { Database, Json } from "@/types/supabase";
import { getStripe } from "@/lib/stripe/client";
import { syncResellerConnectBranding } from "@/lib/stripe/connect";
import { validateWLBrand, WL_COLOR_REGEX } from "@/lib/validation/wl-brand";
import { detectLogoMimeType } from "@/lib/utils/magic-bytes";
import { writeAuditLog } from "@/lib/services/admin";

type SubscriptionStatus = Database["public"]["Enums"]["subscription_status"];
type ResellerOfferStatus = Database["public"]["Enums"]["reseller_offer_status"];

// ── Slug validation ─────────────────────────────────────────────────────────

export async function isSlugAvailable(slug: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  return data === null;
}

export async function setResellerSlug(resellerId: string, slug: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("profiles")
    .update({ slug })
    .eq("id", resellerId);
  if (error) throw new Error(`Failed to set slug: ${error.message}`);
}

// ── Reseller subscription ($19/mo) ──────────────────────────────────────────

export async function getResellerSubscription(resellerId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("reseller_subscriptions")
    .select("*")
    .eq("reseller_id", resellerId)
    .maybeSingle();
  return data;
}

export async function getResellerSubscriptionByStripeId(stripeSubId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("reseller_subscriptions")
    .select("*")
    .eq("stripe_subscription_id", stripeSubId)
    .maybeSingle();
  return data;
}

export async function upsertResellerSubscription({
  resellerId,
  stripeSubId,
  status,
  currentPeriodEnd,
  cancelAtPeriodEnd,
  canceledAt,
}: {
  resellerId: string;
  stripeSubId: string;
  status: SubscriptionStatus;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("reseller_subscriptions").upsert(
    {
      reseller_id: resellerId,
      stripe_subscription_id: stripeSubId,
      status,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: cancelAtPeriodEnd,
      canceled_at: canceledAt,
    },
    { onConflict: "reseller_id" }
  );
  if (error) throw new Error(`Failed to upsert reseller_subscriptions: ${error.message}`);
}

// Active means the reseller may publish offers and accept new sales.
export function isResellerActive(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing";
}

// Pause all active/draft offers when the reseller's platform sub lapses.
export async function pauseOffersOnLapse(resellerId: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("reseller_offers")
    .update({ status: "paused" as ResellerOfferStatus })
    .eq("reseller_id", resellerId)
    .in("status", ["active", "draft"]);
}

// ── Offers ───────────────────────────────────────────────────────────────────

export type ResellerOfferRow = {
  id: string;
  slug: string;
  sell_price_cents: number;
  vendor_floor_snapshot_cents: number;
  stripe_price_id: string | null;
  status: string;
  created_at: string;
  wl_tier: number;
  wl_status: string | null;
  apps: { id: string; name: string; price_cents: number; min_price_cents: number | null; category: string | null } | null;
};

export async function getOffers(resellerId: string): Promise<ResellerOfferRow[]> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from("reseller_offers")
    .select(
      `id, slug, sell_price_cents, vendor_floor_snapshot_cents, stripe_price_id, status, created_at, wl_tier, wl_status,
       apps (id, name, price_cents, min_price_cents, category)`
    )
    .eq("reseller_id", resellerId)
    .order("created_at", { ascending: false }) as { data: ResellerOfferRow[] | null; error: { message: string } | null };
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getOffer(resellerId: string, offerSlug: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("reseller_offers")
    .select(
      `id, slug, sell_price_cents, vendor_floor_snapshot_cents, stripe_price_id, status,
       apps (id, name, description, category, price_cents, min_price_cents)`
    )
    .eq("reseller_id", resellerId)
    .eq("slug", offerSlug)
    .maybeSingle();
  return data;
}

// Returns the offer from the DB after the trigger sets vendor_floor_snapshot_cents.
export async function createOffer({
  resellerId,
  appId,
  slug,
  sellPriceCents,
  stripePriceId,
}: {
  resellerId: string;
  appId: string;
  slug: string;
  sellPriceCents: number;
  stripePriceId: string;
}) {
  const admin = createAdminClient();

  // Server-side guards beyond the DB trigger.
  const { data: app } = await admin
    .from("apps")
    .select("min_price_cents, vendor_id, status")
    .eq("id", appId)
    .single();

  if (!app) throw new Error("App not found");
  if (app.min_price_cents === null || app.min_price_cents === undefined)
    throw new Error("App is not resellable (min_price_cents is null)");
  if (app.vendor_id === resellerId)
    throw new Error("Self-resell: a reseller cannot create an offer for their own app");
  if (app.status !== "approved")
    throw new Error("App is not approved");

  const floor = app.min_price_cents;
  if (sellPriceCents < floor)
    throw new Error(`sell_price_cents (${sellPriceCents}) must be >= app floor (${floor})`);

  // Ensure reseller share would be positive after 5% platform fee.
  // resellerShare = sell - floor - floor(sell * 500 / 10_000)
  const platformFee = Math.floor((sellPriceCents * 500) / 10_000);
  if (sellPriceCents - floor - platformFee <= 0)
    throw new Error(
      `Sell price too close to vendor floor — reseller share would be ≤ 0 after 5% platform fee`
    );

  const { data: inserted, error } = await admin
    .from("reseller_offers")
    .insert({
      reseller_id: resellerId,
      app_id: appId,
      slug,
      sell_price_cents: sellPriceCents,
      vendor_floor_snapshot_cents: floor, // trigger will also set this, but be explicit
      stripe_price_id: stripePriceId,
      status: "draft" as ResellerOfferStatus,
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to create offer: ${error.message}`);
  return inserted;
}

export async function updateOfferStatus(
  resellerId: string,
  offerId: string,
  status: ResellerOfferStatus
): Promise<void> {
  const admin = createAdminClient();

  if (status === "active") {
    // Gate: reseller subscription must be active/trialing
    const resSub = await getResellerSubscription(resellerId);
    if (!resSub || !isResellerActive(resSub.status))
      throw new Error("Reseller subscription must be active to publish offers");

    // Gate: reseller must have payouts_enabled
    const { data: profile } = await admin
      .from("profiles")
      .select("payouts_enabled")
      .eq("id", resellerId)
      .single();
    if (!profile?.payouts_enabled)
      throw new Error("Complete Stripe Connect onboarding before publishing offers");
  }

  const { error } = await admin
    .from("reseller_offers")
    .update({ status })
    .eq("id", offerId)
    .eq("reseller_id", resellerId);
  if (error) throw new Error(`Failed to update offer status: ${error.message}`);
}

// ── Storefront (public) ──────────────────────────────────────────────────────

export async function getStorefrontOffer(resellerSlug: string, offerSlug: string) {
  const admin = createAdminClient();

  // Resolve reseller by slug — include global WL branding for Tier 1 mini-header
  type ResellerProfile = { id: string; display_name: string | null; wl_global_logo_url: string | null; wl_global_brand_color: string | null; wl_global_display_name: string | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: profile } = await (admin as any)
    .from("profiles")
    .select("id, display_name, wl_global_logo_url, wl_global_brand_color, wl_global_display_name")
    .eq("slug", resellerSlug)
    .maybeSingle() as { data: ResellerProfile | null };

  if (!profile) return null;

  const { data: offer } = await admin
    .from("reseller_offers")
    .select(
      `id, slug, sell_price_cents, vendor_floor_snapshot_cents, stripe_price_id, status,
       apps (id, name, description, category, logo_url, vendor_id,
             profiles!apps_vendor_id_fkey (display_name))`
    )
    .eq("reseller_id", profile.id)
    .eq("slug", offerSlug)
    .eq("status", "active")
    .maybeSingle();

  if (!offer) return null;
  return { reseller: profile, offer };
}

// ── Dashboard stats ──────────────────────────────────────────────────────────

export async function getResellerDashboard(resellerId: string) {
  const supabase = await createServerSupabaseClient();

  // MRR per offer via reseller_sale_stats()
  const { data: saleStats } = await supabase.rpc("reseller_sale_stats");

  const active = (saleStats ?? []).filter(
    (s: { status: string }) => s.status === "active" || s.status === "trialing"
  );
  const mrrCents = active.reduce(
    (sum: number, s: { price_cents: number }) => sum + s.price_cents,
    0
  );
  const activeSubs = active.length;

  return { mrrCents, activeSubs, saleStats: saleStats ?? [] };
}

// ── WL Tier 2 upgrade ────────────────────────────────────────────────────────

export async function upgradeOfferToWLTier2(args: {
  resellerId: string;
  offerId: string;
  logoFileKey: string;
  brandColor: string;
  displayName: string;
}): Promise<void> {
  const admin = createAdminClient();

  // 1. Validate: reseller owns offer and has active base sub
  type OfferForUpgrade = { id: string; reseller_id: string; app_id: string; slug: string; apps: { vendor_id: string; profiles: { reseller_openness: string } | null } | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: offer } = await (admin as any)
    .from("reseller_offers")
    .select(
      `id, reseller_id, app_id, slug,
       apps!inner (vendor_id, profiles!apps_vendor_id_fkey (reseller_openness))`
    )
    .eq("id", args.offerId)
    .eq("reseller_id", args.resellerId)
    .maybeSingle() as { data: OfferForUpgrade | null };

  if (!offer) throw new Error("Offer not found or does not belong to this reseller");

  const resSub = await getResellerSubscription(args.resellerId);
  if (!resSub || !isResellerActive(resSub.status)) {
    throw new Error("Reseller base subscription must be active or trialing");
  }

  // 2. Validate brand inputs
  const brandCheck = validateWLBrand(args.displayName);
  if (!brandCheck.ok) throw new Error(`Invalid display name: ${brandCheck.reason}`);
  if (!WL_COLOR_REGEX.test(args.brandColor)) throw new Error("Invalid brand color — must be #RRGGBB");

  // Logo: fetch from Supabase Storage and check magic bytes
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publicBucket = "logos"; // adjust to actual bucket name
  const logoPublicUrl = `${supabaseUrl}/storage/v1/object/public/${publicBucket}/${args.logoFileKey}`;
  const logoResp = await fetch(logoPublicUrl);
  if (!logoResp.ok) throw new Error("Logo file not found in storage");
  const logoBuf = Buffer.from(await logoResp.arrayBuffer());
  if (logoBuf.length > 1_048_576) throw new Error("Logo exceeds 1MB limit");
  const detectedType = detectLogoMimeType(logoBuf);
  if (!detectedType) throw new Error("Logo must be a valid PNG, JPG, or WebP file (no SVG)");

  // 3. Verify vendor has opted into WL
  const vendorOpenness = offer.apps?.profiles?.reseller_openness ?? "open_to_resellers";
  if (vendorOpenness !== "open_to_wl") {
    throw new Error("Vendor has not opted into white-label (reseller_openness must be open_to_wl)");
  }

  // 4. Get reseller's Stripe customer and account IDs
  const { data: resellerProfile } = await admin
    .from("profiles")
    .select("stripe_customer_id, stripe_account_id")
    .eq("id", args.resellerId)
    .maybeSingle();

  if (!resellerProfile?.stripe_customer_id) {
    throw new Error("Reseller has no Stripe customer — complete billing setup first");
  }

  const tier2PriceId = process.env.STRIPE_WL_TIER2_PRICE_ID;
  if (!tier2PriceId) throw new Error("STRIPE_WL_TIER2_PRICE_ID is not configured");

  // 5. Create $29/mo Stripe subscription on platform account
  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.create(
    {
      customer: resellerProfile.stripe_customer_id,
      items: [{ price: tier2PriceId }],
      trial_period_days: 14,
      metadata: { reseller_id: args.resellerId, offer_id: args.offerId, kind: "wl_tier2" },
      payment_behavior: "default_incomplete",
    },
    { idempotencyKey: `wl_tier2_upgrade:offer_${args.offerId}` }
  );

  const trialEnd = new Date();
  trialEnd.setDate(trialEnd.getDate() + 14);

  // 6. Update the offer row (DB constraint validates branding completeness)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from("reseller_offers")
    .update({
      wl_tier: 2,
      wl_logo_url: logoPublicUrl,
      wl_brand_color: args.brandColor,
      wl_display_name: args.displayName,
      wl_stripe_subscription_id: stripeSub.id,
      wl_trial_end: trialEnd.toISOString(),
      wl_status: "trialing",
    })
    .eq("id", args.offerId) as { error: { message: string } | null };

  if (error) {
    // Attempt to cancel Stripe sub to avoid dangling billing
    await stripe.subscriptions.cancel(stripeSub.id).catch(() => null);
    throw new Error(`Failed to upgrade offer: ${error.message}`);
  }

  // 7. Sync Stripe Connect branding if reseller has a connected account
  if (resellerProfile.stripe_account_id) {
    await syncResellerConnectBranding({
      resellerStripeAccountId: resellerProfile.stripe_account_id,
      logoUrl: logoPublicUrl,
      brandColor: args.brandColor,
      displayName: args.displayName,
    });
  }

  // 8. Audit log
  await writeAuditLog({
    actorId: args.resellerId,
    actorRole: "reseller",
    action: "wl_tier2_upgraded",
    entityType: "reseller_offers",
    entityId: args.offerId,
    metadata: { offer_id: args.offerId, display_name: args.displayName, wl_stripe_sub_id: stripeSub.id },
  });
}

export async function cancelWLTier2(args: {
  resellerId: string;
  offerId: string;
}): Promise<void> {
  const admin = createAdminClient();

  type OfferForCancel = { id: string; reseller_id: string; wl_stripe_subscription_id: string | null; wl_status: string | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: offer } = await (admin as any)
    .from("reseller_offers")
    .select("id, reseller_id, wl_stripe_subscription_id, wl_status")
    .eq("id", args.offerId)
    .eq("reseller_id", args.resellerId)
    .maybeSingle() as { data: OfferForCancel | null };

  if (!offer) throw new Error("Offer not found or does not belong to this reseller");

  const wlSubId = offer.wl_stripe_subscription_id;
  const wlStatus = offer.wl_status;

  if (wlSubId) {
    const stripe = getStripe();
    // Cancel immediately if trialing; at period end if active (preserves current period's access)
    if (wlStatus === "trialing") {
      await stripe.subscriptions.cancel(wlSubId).catch(() => null);
    } else {
      await stripe.subscriptions.update(wlSubId, { cancel_at_period_end: true }).catch(() => null);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from("reseller_offers")
    .update({ wl_tier: 1, wl_status: "canceled" })
    .eq("id", args.offerId);

  await writeAuditLog({
    actorId: args.resellerId,
    actorRole: "reseller",
    action: "wl_tier2_canceled",
    entityType: "reseller_offers",
    entityId: args.offerId,
    metadata: { offer_id: args.offerId },
  });
}

// ── Global mini-branding (Tier 1, free) ─────────────────────────────────────

export async function setResellerGlobalBranding(args: {
  resellerId: string;
  logoFileKey: string;
  brandColor: string;
  displayName: string;
}): Promise<void> {
  const admin = createAdminClient();

  const brandCheck = validateWLBrand(args.displayName);
  if (!brandCheck.ok) throw new Error(`Invalid display name: ${brandCheck.reason}`);
  if (!WL_COLOR_REGEX.test(args.brandColor)) throw new Error("Invalid brand color — must be #RRGGBB");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publicBucket = "logos";
  const logoPublicUrl = `${supabaseUrl}/storage/v1/object/public/${publicBucket}/${args.logoFileKey}`;
  const logoResp = await fetch(logoPublicUrl);
  if (!logoResp.ok) throw new Error("Logo file not found in storage");
  const logoBuf = Buffer.from(await logoResp.arrayBuffer());
  if (logoBuf.length > 1_048_576) throw new Error("Logo exceeds 1MB limit");
  const detectedType = detectLogoMimeType(logoBuf);
  if (!detectedType) throw new Error("Logo must be a valid PNG, JPG, or WebP file (no SVG)");

  // Require active/trialing base sub
  const resSub = await getResellerSubscription(args.resellerId);
  if (!resSub || !isResellerActive(resSub.status)) {
    throw new Error("Active reseller subscription required to set global branding");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from("profiles")
    .update({ wl_global_logo_url: logoPublicUrl, wl_global_brand_color: args.brandColor, wl_global_display_name: args.displayName })
    .eq("id", args.resellerId) as { error: { message: string } | null };

  if (error) throw new Error(`Failed to set global branding: ${error.message}`);

  await writeAuditLog({
    actorId: args.resellerId,
    actorRole: "reseller",
    action: "reseller_global_branding_updated",
    entityType: "profiles",
    entityId: args.resellerId,
    metadata: { display_name: args.displayName },
  });
}

export async function clearResellerGlobalBranding(resellerId: string): Promise<void> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from("profiles")
    .update({ wl_global_logo_url: null, wl_global_brand_color: null, wl_global_display_name: null })
    .eq("id", resellerId) as { error: { message: string } | null };
  if (error) throw new Error(`Failed to clear global branding: ${error.message}`);
  await writeAuditLog({
    actorId: resellerId,
    actorRole: "reseller",
    action: "reseller_global_branding_cleared",
    entityType: "profiles",
    entityId: resellerId,
    metadata: {},
  });
}

// WL Tier 2 storefront — looks up offer by reseller slug + offer slug.
// Returns null (→ 404) for any condition: non-existent, wrong tier, lapsed subs, vendor not open_to_wl.
export async function getWLStorefrontOffer(resellerSlug: string, offerSlug: string) {
  const admin = createAdminClient();

  type WLProfile = { id: string; wl_global_display_name: string | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: profile } = await (admin as any)
    .from("profiles")
    .select("id, wl_global_display_name")
    .eq("slug", resellerSlug)
    .maybeSingle() as { data: WLProfile | null };

  if (!profile) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: offer } = await (admin as any)
    .from("reseller_offers")
    .select(
      `id, slug, sell_price_cents, vendor_floor_snapshot_cents, stripe_price_id, status,
       wl_tier, wl_logo_url, wl_brand_color, wl_display_name, wl_status,
       apps (id, name, description, category, logo_url, vendor_id,
             profiles!apps_vendor_id_fkey (display_name, reseller_openness))`
    )
    .eq("reseller_id", profile.id)
    .eq("slug", offerSlug)
    .maybeSingle() as { data: Record<string, unknown> | null };

  if (!offer) return null;
  const offerRecord = offer;

  // All conditions must be met — any failure returns null (no info leak via error messages)
  if (offerRecord.wl_tier !== 2) return null;
  if (offerRecord.wl_status !== "trialing" && offerRecord.wl_status !== "active") return null;
  if (offerRecord.status !== "active") return null;

  const appData = offerRecord.apps as Record<string, unknown> | null;
  const vendorProfile = appData?.profiles as Record<string, unknown> | null;
  if (vendorProfile?.reseller_openness !== "open_to_wl") return null;

  // Reseller base sub must be active
  const resSub = await getResellerSubscription(profile.id);
  if (!resSub || !isResellerActive(resSub.status)) return null;

  return { reseller: profile, offer: offerRecord };
}

// Get all Tier 2 active offers for a reseller (subdomain landing page)
export async function getWLStorefrontOffers(resellerSlug: string) {
  const admin = createAdminClient();

  type WLProfileOffers = { id: string; wl_global_display_name: string | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: profile } = await (admin as any)
    .from("profiles")
    .select("id, wl_global_display_name")
    .eq("slug", resellerSlug)
    .maybeSingle() as { data: WLProfileOffers | null };

  if (!profile) return null;

  const resSub = await getResellerSubscription(profile.id);
  if (!resSub || !isResellerActive(resSub.status)) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: offers } = await (admin as any)
    .from("reseller_offers")
    .select(
      `id, slug, sell_price_cents, wl_tier, wl_logo_url, wl_brand_color, wl_display_name, wl_status, status,
       apps (id, name, description, category, logo_url)`
    )
    .eq("reseller_id", profile.id)
    .eq("status", "active") as { data: Record<string, unknown>[] | null };

  const tier2Offers = ((offers ?? []) as Record<string, unknown>[]).filter(
    (o) => o.wl_tier === 2 && (o.wl_status === "trialing" || o.wl_status === "active")
  );

  return { reseller: profile, offers: tier2Offers };
}

// ── Vendor reseller openness ─────────────────────────────────────────────────

export async function setResellerOpenness(
  vendorId: string,
  openness: "closed" | "open_to_resellers" | "open_to_wl"
): Promise<void> {
  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: current } = await (admin as any)
    .from("profiles")
    .select("reseller_openness")
    .eq("id", vendorId)
    .maybeSingle() as { data: { reseller_openness: string } | null };

  const oldOpenness = current?.reseller_openness ?? "open_to_resellers";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from("profiles")
    .update({ reseller_openness: openness })
    .eq("id", vendorId) as { error: { message: string } | null };

  if (error) throw new Error(`Failed to update reseller openness: ${error.message}`);

  // Closing: pause all active reseller offers for this vendor's apps
  if (openness === "closed") {
    const { data: apps } = await admin.from("apps").select("id").eq("vendor_id", vendorId);
    if (apps && apps.length > 0) {
      const appIds = apps.map((a) => a.id);
      await admin
        .from("reseller_offers")
        .update({ status: "paused" as "paused" })
        .in("app_id", appIds)
        .in("status", ["active", "draft"]);
    }
  }

  await writeAuditLog({
    actorId: vendorId,
    actorRole: "vendor",
    action: "vendor_reseller_openness_changed",
    entityType: "profiles",
    entityId: vendorId,
    metadata: { old: oldOpenness, new: openness },
  });
}

// ── Resellable apps (vendor opted in, approved, not the reseller's own)
export async function getResellableApps(resellerId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("apps")
    .select(
      `id, name, description, category, price_cents, min_price_cents,
       profiles!apps_vendor_id_fkey (display_name)`
    )
    .eq("status", "approved")
    .not("min_price_cents", "is", null)
    .neq("vendor_id", resellerId);
  if (error) throw new Error(error.message);
  return data ?? [];
}
