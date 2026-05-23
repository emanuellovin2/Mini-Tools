"use server";

import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAffiliateLink, updateAffiliateProfile } from "@/lib/services/affiliate";

const createLinkSchema = z.object({
  app_id: z.string().uuid().optional().nullable(),
});

export type CreateLinkResult = { code: string; url: string } | { error: string };

export async function createAffiliateLinkAction(
  formData: FormData
): Promise<CreateLinkResult> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "affiliate") return { error: "Forbidden" };

  const raw = { app_id: formData.get("app_id") as string | null };
  const parsed = createLinkSchema.safeParse(raw);
  if (!parsed.success) return { error: "Invalid input" };

  const { code } = await createAffiliateLink(user.id, parsed.data.app_id ?? null);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  return { code, url: `${appUrl}/marketplace?aff=${code}` };
}

const SLUG_REGEX = /^[a-z0-9-]{3,40}$/;

const profileSchema = z.object({
  slug: z.string().regex(SLUG_REGEX).or(z.literal("")).optional(),
  bio: z.string().max(500).optional(),
  avatar_url: z.string().url().or(z.literal("")).optional(),
});

export type UpdateProfileResult = { ok: true } | { error: string };

export async function updateAffiliateProfileAction(
  formData: FormData
): Promise<UpdateProfileResult> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "affiliate") return { error: "Forbidden" };

  const raw = {
    slug: (formData.get("slug") as string) ?? "",
    bio: (formData.get("bio") as string) ?? "",
    avatar_url: (formData.get("avatar_url") as string) ?? "",
  };

  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) return { error: "Invalid input" };

  const result = await updateAffiliateProfile(user.id, {
    slug: parsed.data.slug || null,
    bio: parsed.data.bio || null,
    avatar_url: parsed.data.avatar_url || null,
  });

  return result.error ? { error: result.error } : { ok: true };
}
