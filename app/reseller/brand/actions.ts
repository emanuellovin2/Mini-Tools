"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { setResellerGlobalBranding, clearResellerGlobalBranding } from "@/lib/services/reseller";

export type ActionResult = { success: true } | { error: string };

async function requireReseller() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, authed: false as const };
  const admin = createAdminClient();
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "reseller") return { user: null, authed: false as const };
  return { user, authed: true as const };
}

export async function setResellerGlobalBrandingAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { user, authed } = await requireReseller();
  if (!authed) return { error: "Not authenticated as a reseller" };

  const logoFile = formData.get("logo") as File | null;
  const brandColor = (formData.get("brand_color") as string | null)?.trim() ?? "";
  const displayName = (formData.get("display_name") as string | null)?.trim() ?? "";

  if (!logoFile || logoFile.size === 0) return { error: "Logo file is required" };

  // Upload logo to Supabase Storage
  const { createAdminClient: adminClient } = await import("@/lib/services/supabase");
  const admin = adminClient();
  const buf = Buffer.from(await logoFile.arrayBuffer());
  const fileKey = `reseller/${user!.id}/global-logo-${Date.now()}.png`;
  const { error: uploadError } = await admin.storage
    .from("logos")
    .upload(fileKey, buf, { contentType: logoFile.type || "image/png", upsert: true });

  if (uploadError) return { error: `Upload failed: ${uploadError.message}` };

  try {
    await setResellerGlobalBranding({
      resellerId: user!.id,
      logoFileKey: fileKey,
      brandColor,
      displayName,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save branding" };
  }

  revalidatePath("/reseller/brand");
  revalidatePath("/reseller");
  return { success: true };
}

export async function clearResellerGlobalBrandingAction(
  _prev: ActionResult | null,
  _formData: FormData
): Promise<ActionResult> {
  const { user, authed } = await requireReseller();
  if (!authed) return { error: "Not authenticated as a reseller" };

  try {
    await clearResellerGlobalBranding(user!.id);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to clear branding" };
  }

  revalidatePath("/reseller/brand");
  return { success: true };
}
