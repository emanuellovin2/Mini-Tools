"use server";

import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAffiliateLink } from "@/lib/services/affiliate";

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
