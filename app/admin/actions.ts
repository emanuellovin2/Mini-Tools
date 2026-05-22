"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { approveAppWithStripe } from "@/lib/stripe/products";
import { syncConnectStatus } from "@/lib/stripe/connect";
import type { Json } from "@/types/supabase";

const uuidParam = z.string().uuid("Invalid ID");

type ActionResult = { success: true; message?: string } | { error: string };

async function requireAdmin() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") return null;
  return user;
}

export async function approveAppAction(appId: string): Promise<ActionResult> {
  if (!uuidParam.safeParse(appId).success) return { error: "Invalid app ID" };
  const user = await requireAdmin();
  if (!user) return { error: "Forbidden" };

  try {
    const { productId, priceId } = await approveAppWithStripe(appId);

    const admin = createAdminClient();
    await admin.from("audit_log").insert({
      actor_id: user.id,
      actor_role: "admin",
      action: "app.approved",
      entity_type: "apps",
      entity_id: appId,
      metadata: { product_id: productId, price_id: priceId } as unknown as Json,
    });

    revalidatePath("/admin");
    return { success: true, message: "App approved and Stripe Price created." };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function rejectAppAction(appId: string): Promise<ActionResult> {
  if (!uuidParam.safeParse(appId).success) return { error: "Invalid app ID" };
  const user = await requireAdmin();
  if (!user) return { error: "Forbidden" };

  const admin = createAdminClient();
  const { error } = await admin
    .from("apps")
    .update({ status: "rejected" })
    .eq("id", appId);

  if (error) return { error: error.message };

  await admin.from("audit_log").insert({
    actor_id: user.id,
    actor_role: "admin",
    action: "app.rejected",
    entity_type: "apps",
    entity_id: appId,
    metadata: null,
  });

  revalidatePath("/admin");
  return { success: true };
}

export async function syncVendorStripeAction(
  vendorId: string
): Promise<ActionResult> {
  if (!uuidParam.safeParse(vendorId).success) return { error: "Invalid vendor ID" };
  const user = await requireAdmin();
  if (!user) return { error: "Forbidden" };

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", vendorId)
    .single();

  if (!profile?.stripe_account_id) {
    return { error: "Vendor has no Stripe Connect account" };
  }

  try {
    const { charges_enabled, payouts_enabled } = await syncConnectStatus(
      vendorId,
      profile.stripe_account_id
    );

    await admin.from("audit_log").insert({
      actor_id: user.id,
      actor_role: "admin",
      action: "vendor.stripe_synced",
      entity_type: "profiles",
      entity_id: vendorId,
      metadata: { charges_enabled, payouts_enabled } as unknown as Json,
    });

    revalidatePath("/admin");
    return {
      success: true,
      message: `charges=${charges_enabled} payouts=${payouts_enabled}`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unknown error" };
  }
}
