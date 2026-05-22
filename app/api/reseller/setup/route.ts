import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { getStripe } from "@/lib/stripe/client";
import { getOrCreateStripeCustomer } from "@/lib/stripe/customers";

export const runtime = "nodejs";

// POST /api/reseller/setup
// Creates a Stripe Checkout session for the reseller's $19/mo platform subscription.
export async function POST(_req: NextRequest): Promise<NextResponse> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, stripe_customer_id")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "reseller") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const priceId = process.env.STRIPE_RESELLER_PLAN_PRICE_ID;
  if (!priceId) {
    return NextResponse.json({ error: "STRIPE_RESELLER_PLAN_PRICE_ID not configured" }, { status: 500 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const stripe = getStripe();

  const customerId = await getOrCreateStripeCustomer(user.id, user.email ?? "");

  // Anti-abuse: only offer trial to first-time resellers
  const admin = createAdminClient();
  const { data: prior } = await admin
    .from("reseller_subscriptions")
    .select("id")
    .eq("reseller_id", user.id)
    .maybeSingle();
  const trialDays = prior ? 0 : (Number(process.env.RESELLER_TRIAL_DAYS) || 30);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/reseller?setup=success`,
    cancel_url: `${appUrl}/reseller/setup?setup=cancelled`,
    metadata: {
      reseller_platform_sub: "true",
      reseller_id: user.id,
    },
    subscription_data: {
      trial_period_days: trialDays > 0 ? trialDays : undefined,
      metadata: {
        reseller_platform_sub: "true",
        reseller_id: user.id,
      },
    },
  });

  return NextResponse.json({ url: session.url });
}
