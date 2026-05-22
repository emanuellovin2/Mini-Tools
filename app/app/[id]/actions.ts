"use server";

import { headers, cookies } from "next/headers";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { getStripe } from "@/lib/stripe/client";
import { getOrCreateStripeCustomer } from "@/lib/stripe/customers";
import { lookupOrGenerateAnonUserId } from "@/lib/stripe/anon-user";
import { validateAffiliateCode } from "@/lib/services/affiliate";
import { checkRateLimit } from "@/lib/utils/rate-limit";

const uuidParam = z.string().uuid("Invalid app ID");

export type SubscribeResult = { url: string } | { error: string };

// 10 subscribe attempts per buyer per minute — prevents rapid checkout spam
const SUBSCRIBE_RATE_LIMIT = 10;
const SUBSCRIBE_RATE_WINDOW_MS = 60_000;

export async function subscribeAction(appId: string): Promise<SubscribeResult> {
  if (!uuidParam.safeParse(appId).success) return { error: "Invalid app ID" };
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to subscribe" };

  // Rate-limit per buyer: 10 subscribe attempts/minute
  const ip =
    ((await headers()).get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    `user:${user.id}`;
  const { allowed } = checkRateLimit(
    `subscribe:${ip}`,
    SUBSCRIBE_RATE_LIMIT,
    SUBSCRIBE_RATE_WINDOW_MS
  );
  if (!allowed) return { error: "Too many requests — please wait a moment" };

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "buyer") return { error: "Only buyers can subscribe to apps" };

  const admin = createAdminClient();
  const { data: app } = await admin
    .from("apps")
    .select("id, name, stripe_price_id, status, vendor_id, affiliate_commission_bps")
    .eq("id", appId)
    .single();

  if (!app) return { error: "App not found" };
  if (app.status !== "approved") return { error: "This app is not available for subscription" };
  if (!app.stripe_price_id) return { error: "App is not set up for payments yet" };

  // Friendly pre-check: no current active/pending subscription
  const { data: existingSub } = await supabase
    .from("subscriptions")
    .select("id, status")
    .eq("app_id", appId)
    .in("status", ["active", "trialing", "incomplete", "past_due"])
    .maybeSingle();

  if (existingSub) {
    return { error: "You already have an active subscription to this app" };
  }

  const customerId = await getOrCreateStripeCustomer(user.id, user.email ?? "");

  // Stable anon_user_id across resubscriptions — SPEC §6
  const anonUserId = await lookupOrGenerateAnonUserId(user.id, appId);

  // Resolve affiliate attribution from aff_code cookie.
  // Only attribute if the app has affiliate_commission_bps set (vendor opted in).
  const cookieStore = await cookies();
  const affCode = cookieStore.get("aff_code")?.value ?? null;
  let resolvedAffiliateId: string | null = null;
  if (affCode && app.affiliate_commission_bps !== null) {
    const link = await validateAffiliateCode(affCode);
    // Self-referral guard: drop attribution if the affiliate is the buyer
    if (link && link.affiliate_id !== user.id) {
      resolvedAffiliateId = link.affiliate_id;
    }
    // Clear the cookie now that attribution has been captured in session metadata
    cookieStore.delete("aff_code");
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const stripe = getStripe();

  const baseMeta: Record<string, string> = {
    buyer_id: user.id,
    app_id: appId,
    anon_user_id: anonUserId,
  };
  if (resolvedAffiliateId && app.affiliate_commission_bps !== null) {
    baseMeta.affiliate_id = resolvedAffiliateId;
    baseMeta.aff_code = affCode!;
    baseMeta.affiliate_commission_snapshot_bps = String(app.affiliate_commission_bps);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: app.stripe_price_id, quantity: 1 }],
    success_url: `${appUrl}/app/${appId}?checkout=success`,
    cancel_url: `${appUrl}/app/${appId}?checkout=cancel`,
    // Both session and subscription carry metadata so invoice.paid can resolve
    // app_id even if checkout.session.completed fires after it (edge case)
    metadata: baseMeta,
    subscription_data: { metadata: baseMeta },
  });

  return { url: session.url! };
}
