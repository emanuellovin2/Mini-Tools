"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { createOffer, updateOfferStatus, setResellerSlug, isSlugAvailable } from "@/lib/services/reseller";
import { createOfferSchema, slugSchema } from "@/lib/validation/reseller";
import { getStripe } from "@/lib/stripe/client";
import type { Database } from "@/types/supabase";

type ResellerOfferStatus = Database["public"]["Enums"]["reseller_offer_status"];

export type ActionResult = { success: true } | { error: string | Record<string, string[]> };

async function requireReseller() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, supabase, authed: false as const };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, slug, stripe_account_id, charges_enabled, payouts_enabled")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "reseller") return { user: null, supabase, authed: false as const };
  return { user, profile, supabase, authed: true as const };
}

// Setup: set the reseller's storefront slug (first-time only)
export async function setupResellerSlugAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { user, authed } = await requireReseller();
  if (!authed) return { error: "Not authenticated as a reseller" };

  const parsed = slugSchema.safeParse({ slug: formData.get("slug") });
  if (!parsed.success) {
    return { error: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }

  const { slug } = parsed.data;
  const available = await isSlugAvailable(slug);
  if (!available) return { error: { slug: ["This slug is already taken"] } };

  try {
    await setResellerSlug(user!.id, slug);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to set slug" };
  }

  revalidatePath("/reseller");
  return { success: true };
}

// Create a new reseller offer + matching Stripe Price
export async function createOfferAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { user, authed } = await requireReseller();
  if (!authed) return { error: "Not authenticated as a reseller" };

  const raw = {
    app_id: formData.get("app_id"),
    slug: formData.get("slug"),
    sell_price_dollars: Number(formData.get("sell_price_dollars")),
  };

  const parsed = createOfferSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }

  const sellPriceCents = Math.round(parsed.data.sell_price_dollars * 100);

  // Fetch the app to get its Stripe Product ID (needed to create a Price)
  const admin = createAdminClient();
  const { data: app } = await admin
    .from("apps")
    .select("stripe_product_id, name, min_price_cents")
    .eq("id", parsed.data.app_id)
    .single();

  if (!app?.stripe_product_id) {
    return { error: "App is not yet approved or has no Stripe product" };
  }
  if (app.min_price_cents === null || app.min_price_cents === undefined) {
    return { error: "App is not resellable" };
  }

  // Create a per-offer recurring Stripe Price on the platform account
  let stripePriceId: string;
  try {
    const stripe = getStripe();
    const price = await stripe.prices.create({
      product: app.stripe_product_id,
      unit_amount: sellPriceCents,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { reseller_id: user!.id, offer_slug: parsed.data.slug },
    });
    stripePriceId = price.id;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create Stripe price" };
  }

  try {
    await createOffer({
      resellerId: user!.id,
      appId: parsed.data.app_id,
      slug: parsed.data.slug,
      sellPriceCents,
      stripePriceId,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create offer" };
  }

  revalidatePath("/reseller/offers");
  return { success: true };
}

// Update offer status (active / paused / draft)
export async function updateOfferStatusAction(
  offerId: string,
  status: ResellerOfferStatus
): Promise<ActionResult> {
  const { user, authed } = await requireReseller();
  if (!authed) return { error: "Not authenticated as a reseller" };

  try {
    await updateOfferStatus(user!.id, offerId, status);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update offer" };
  }

  revalidatePath("/reseller/offers");
  return { success: true };
}
