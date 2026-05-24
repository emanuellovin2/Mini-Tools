"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { createOffer, updateOfferStatus, setResellerSlug, isSlugAvailable, upgradeOfferToWLTier2, cancelWLTier2 } from "@/lib/services/reseller";
import { createOfferSchema, slugSchema } from "@/lib/validation/reseller";
import { getStripe } from "@/lib/stripe/client";
import { enforceQuota, QuotaExceededError } from "@/lib/quotas/enforce";
import { getPersonalOrgId } from "@/lib/services/org";
import { withStandardTimeout } from "@/lib/db/with-timeout";
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

  // Default-deny quota check: every creatable resource must enforce its org quota (#48).
  try {
    const orgId = await getPersonalOrgId(user!.id);
    await enforceQuota(orgId, "offers");
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      return {
        error: `You've reached your offers quota (${e.used}/${e.limit}). Contact support to raise it.`,
      };
    }
    // Quota lookup failure must not block legitimate offer creation
    console.warn(JSON.stringify({
      event: "quota.lookup_failed",
      resource: "offers",
      user_id: user!.id,
      error: e instanceof Error ? e.message : String(e),
    }));
  }

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
    // Bound the DB work to 30s; unbounded waits on a busy node are how stuck
    // server actions tie up RPC slots indefinitely.
    await withStandardTimeout(() =>
      createOffer({
        resellerId: user!.id,
        appId: parsed.data.app_id,
        slug: parsed.data.slug,
        sellPriceCents,
        stripePriceId,
      })
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create offer" };
  }

  revalidatePath("/reseller/offers");
  return { success: true };
}

// Upgrade an offer to WL Tier 2
export async function upgradeOfferToWLTier2Action(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { user, authed } = await requireReseller();
  if (!authed) return { error: "Not authenticated as a reseller" };

  const offerId = formData.get("offer_id") as string | null;
  const brandColor = (formData.get("brand_color") as string | null)?.trim() ?? "";
  const displayName = (formData.get("display_name") as string | null)?.trim() ?? "";
  const logoFile = formData.get("logo") as File | null;

  if (!offerId) return { error: "Missing offer ID" };
  if (!logoFile || logoFile.size === 0) return { error: "Logo file is required" };

  // Upload logo
  const { createAdminClient: adminClient } = await import("@/lib/services/supabase");
  const admin = adminClient();
  const buf = Buffer.from(await logoFile.arrayBuffer());
  const fileKey = `reseller/${user!.id}/offer-${offerId}-logo-${Date.now()}.png`;
  const { error: uploadError } = await admin.storage
    .from("logos")
    .upload(fileKey, buf, { contentType: logoFile.type || "image/png", upsert: true });
  if (uploadError) return { error: `Upload failed: ${uploadError.message}` };

  try {
    await upgradeOfferToWLTier2({
      resellerId: user!.id,
      offerId,
      logoFileKey: fileKey,
      brandColor,
      displayName,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Upgrade failed" };
  }

  revalidatePath("/reseller/offers");
  return { success: true };
}

// Cancel WL Tier 2 on an offer
export async function cancelWLTier2Action(offerId: string): Promise<ActionResult> {
  const { user, authed } = await requireReseller();
  if (!authed) return { error: "Not authenticated as a reseller" };

  try {
    await cancelWLTier2({ resellerId: user!.id, offerId });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to cancel WL Tier 2" };
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

// Markup simulator — Server Action called from client slider
export async function markupSimulateAction(
  offerId: string,
  newPriceCents: number
): Promise<import("@/lib/services/reseller").MarkupSimResult> {
  const { user, authed } = await requireReseller();
  if (!authed) {
    return {
      sell_price_cents: newPriceCents,
      vendor_floor_cents: 0,
      reseller_share_cents: 0,
      platform_cut_cents: 0,
      vendor_share_cents: newPriceCents,
      monthly_reseller_share_cents: 0,
    };
  }
  const { markupSimulate } = await import("@/lib/services/reseller");
  try {
    return await markupSimulate(offerId, user!.id, newPriceCents);
  } catch {
    return {
      sell_price_cents: newPriceCents,
      vendor_floor_cents: 0,
      reseller_share_cents: 0,
      platform_cut_cents: 0,
      vendor_share_cents: newPriceCents,
      monthly_reseller_share_cents: 0,
    };
  }
}
