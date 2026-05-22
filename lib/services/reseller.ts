import { createAdminClient } from "@/lib/services/supabase";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import type { Database } from "@/types/supabase";

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

export async function getOffers(resellerId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("reseller_offers")
    .select(
      `id, slug, sell_price_cents, vendor_floor_snapshot_cents, stripe_price_id, status, created_at,
       apps (id, name, price_cents, min_price_cents, category)`
    )
    .eq("reseller_id", resellerId)
    .order("created_at", { ascending: false });
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

  // Resolve reseller by slug
  const { data: profile } = await admin
    .from("profiles")
    .select("id, display_name")
    .eq("slug", resellerSlug)
    .maybeSingle();

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

// Resellable apps (vendor opted in, approved, not the reseller's own)
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
