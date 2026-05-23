import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { getStripe } from "@/lib/stripe/client";
import { getOrCreateStripeCustomer } from "@/lib/stripe/customers";
import { lookupOrGenerateAnonUserId } from "@/lib/stripe/anon-user";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  offer_id: z.string().uuid(),
});

// POST /api/reseller/checkout
// Creates a Stripe Checkout session for a buyer subscribing via a reseller offer.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { offer_id } = parsed.data;
  const admin = createAdminClient();

  const { data: offer } = await admin
    .from("reseller_offers")
    .select(
      `id, reseller_id, app_id, slug, sell_price_cents, vendor_floor_snapshot_cents, stripe_price_id, status,
       apps (id, name, auth_url, vendor_id),
       reseller:profiles!reseller_offers_reseller_id_fkey (slug)`
    )
    .eq("id", offer_id)
    .eq("status", "active")
    .maybeSingle();

  if (!offer) {
    return NextResponse.json({ error: "Offer not found or not active" }, { status: 404 });
  }

  const resellerProfile = offer.reseller as { slug: string | null } | null;
  const resellerSlug = resellerProfile?.slug;
  if (!resellerSlug) {
    return NextResponse.json({ error: "Reseller has no public slug" }, { status: 500 });
  }

  // Self-resell guard: buyer cannot be the reseller.
  if (offer.reseller_id === user.id) {
    return NextResponse.json({ error: "Self-resell is not allowed" }, { status: 400 });
  }

  // Reseller must have active subscription to accept new sales.
  const { data: resSub } = await admin
    .from("reseller_subscriptions")
    .select("status")
    .eq("reseller_id", offer.reseller_id)
    .maybeSingle();

  const resellerActive = resSub?.status === "active" || resSub?.status === "trialing";
  if (!resellerActive) {
    return NextResponse.json({ error: "Reseller is not currently active" }, { status: 400 });
  }

  if (!offer.stripe_price_id) {
    return NextResponse.json({ error: "Offer has no Stripe Price configured" }, { status: 500 });
  }

  const apps = offer.apps as { id: string; name: string; auth_url: string | null; vendor_id: string } | null;
  if (!apps) return NextResponse.json({ error: "App not found" }, { status: 500 });

  const customerId = await getOrCreateStripeCustomer(user.id, user.email ?? "");
  const anonUserId = await lookupOrGenerateAnonUserId(user.id, apps.id);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  // Reseller takes priority — ignore any affiliate cookie (SPEC §4).
  // No affiliate attribution for reseller-sold subscriptions.

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: offer.stripe_price_id, quantity: 1 }],
    success_url: `${appUrl}/buyer?subscribed=1`,
    cancel_url: `${appUrl}/r/${encodeURIComponent(resellerSlug)}/${encodeURIComponent(offer.slug)}`,
    metadata: {
      buyer_id: user.id,
      app_id: apps.id,
      anon_user_id: anonUserId,
      reseller_id: offer.reseller_id,
      reseller_offer_id: offer.id,
      vendor_floor_snapshot_cents: String(offer.vendor_floor_snapshot_cents),
    },
    subscription_data: {
      metadata: {
        buyer_id: user.id,
        app_id: apps.id,
        reseller_id: offer.reseller_id,
        reseller_offer_id: offer.id,
      },
    },
  });

  return NextResponse.json({ url: session.url });
}
