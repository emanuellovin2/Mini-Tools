"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { appSubmitSchema, displayNameSchema } from "@/lib/validation/vendor";
import { detectLogoMimeType } from "@/lib/utils/magic-bytes";
import { setResellerOpenness } from "@/lib/services/reseller";
import { getPersonalOrgId } from "@/lib/services/org";
import { z } from "zod";

export type ActionResult =
  | { success: true }
  | { error: string | Record<string, string[]> };

async function requireVendor() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, supabase, authed: false as const };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "vendor")
    return { user: null, supabase, authed: false as const };
  return { user, supabase, authed: true as const };
}

export async function submitAppAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { user, supabase, authed } = await requireVendor();
  if (!authed) return { error: "Not authenticated as a vendor" };

  const raw = {
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    category: formData.get("category") || undefined,
    price_dollars: formData.get("price_dollars"),
    min_price_dollars: formData.get("min_price_dollars") || undefined,
    auth_url: formData.get("auth_url"),
  };

  const parsed = appSubmitSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }

  // Screenshots — must have 3–7 before submission
  const screenshotUrls = formData.getAll("screenshot_urls") as string[];
  const validScreenshots = screenshotUrls.filter(
    (u) => typeof u === "string" && u.startsWith("https://")
  );
  if (validScreenshots.length < 3) {
    return { error: { screenshot_urls: ["At least 3 screenshots are required"] } };
  }
  if (validScreenshots.length > 7) {
    return { error: { screenshot_urls: ["Maximum 7 screenshots allowed"] } };
  }

  // Logo upload with server-side magic byte validation
  const logoFile = formData.get("logo") as File | null;
  let logo_url: string | null = null;

  if (logoFile && logoFile.size > 0) {
    if (logoFile.size > 1_048_576) {
      return { error: { logo: ["File exceeds 1 MB limit"] } };
    }

    const buf = Buffer.from(await logoFile.arrayBuffer());
    const detectedType = detectLogoMimeType(buf);
    if (!detectedType) {
      return {
        error: {
          logo: ["Invalid image format. Only PNG, JPG, and WebP are accepted."],
        },
      };
    }

    const ext =
      detectedType === "image/jpeg"
        ? "jpg"
        : detectedType === "image/png"
          ? "png"
          : "webp";
    const storagePath = `${user!.id}/${crypto.randomUUID()}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from("app-logos")
      .upload(storagePath, buf, { contentType: detectedType, upsert: false });
    if (uploadErr) return { error: { logo: [uploadErr.message] } };

    const {
      data: { publicUrl },
    } = supabase.storage.from("app-logos").getPublicUrl(storagePath);
    logo_url = publicUrl;
  }

  const price_cents = Math.round(parsed.data.price_dollars * 100);
  const min_price_cents =
    parsed.data.min_price_dollars !== undefined
      ? Math.round(parsed.data.min_price_dollars * 100)
      : null;

  const orgId = await getPersonalOrgId(user!.id);

  const { error: insertErr } = await supabase.from("apps").insert({
    vendor_id: user!.id,
    org_id: orgId,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    category: parsed.data.category ?? null,
    price_cents,
    min_price_cents,
    auth_url: parsed.data.auth_url,
    logo_url,
    screenshot_urls: validScreenshots,
    status: "pending",
  });

  if (insertErr) return { error: insertErr.message };

  revalidatePath("/vendor");
  return { success: true };
}

export async function updateAffiliateCommissionAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { user, supabase, authed } = await requireVendor();
  if (!authed) return { error: "Not authenticated as a vendor" };

  const appId = formData.get("app_id") as string;
  if (!appId) return { error: "Missing app ID" };

  const rawBps = formData.get("affiliate_commission_bps");
  // Empty value = disable affiliate program for this app (set to null)
  if (!rawBps || rawBps === "") {
    const { error } = await supabase
      .from("apps")
      .update({ affiliate_commission_bps: null })
      .eq("id", appId)
      .eq("vendor_id", user!.id);
    if (error) return { error: error.message };
    revalidatePath("/vendor");
    return { success: true };
  }

  const bps = parseInt(rawBps as string, 10);
  if (isNaN(bps) || bps < 2000 || bps > 8000) {
    return { error: { affiliate_commission_bps: ["Must be between 20% and 80%"] } };
  }

  const { error } = await supabase
    .from("apps")
    .update({ affiliate_commission_bps: bps })
    .eq("id", appId)
    .eq("vendor_id", user!.id);
  if (error) return { error: error.message };

  revalidatePath("/vendor");
  return { success: true };
}

export async function updateDisplayNameAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { user, supabase, authed } = await requireVendor();
  if (!authed) return { error: "Not authenticated as a vendor" };

  const parsed = displayNameSchema.safeParse({
    display_name: formData.get("display_name"),
  });
  if (!parsed.success) {
    return { error: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }

  const { error: updateErr } = await supabase
    .from("profiles")
    .update({ display_name: parsed.data.display_name })
    .eq("id", user!.id);

  if (updateErr) return { error: updateErr.message };

  revalidatePath("/vendor");
  revalidatePath("/marketplace");
  return { success: true };
}

const resellerOpennessSchema = z.object({
  openness: z.enum(["closed", "open_to_resellers", "open_to_wl"]),
});

export async function setResellerOpennessAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { user, authed } = await requireVendor();
  if (!authed) return { error: "Not authenticated as a vendor" };

  const parsed = resellerOpennessSchema.safeParse({ openness: formData.get("openness") });
  if (!parsed.success) return { error: parsed.error.flatten().fieldErrors as Record<string, string[]> };

  try {
    await setResellerOpenness(user!.id, parsed.data.openness);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update reseller openness" };
  }

  revalidatePath("/vendor");
  return { success: true };
}
