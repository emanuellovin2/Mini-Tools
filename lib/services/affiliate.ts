import { createAdminClient } from "./supabase";
import { createServerSupabaseClient } from "./supabase-server";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function generateCode(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => BASE62[b % 62]).join("");
}

export async function createAffiliateLink(
  affiliateId: string,
  appId?: string | null
): Promise<{ code: string }> {
  const admin = createAdminClient();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode(8);
    const { error } = await admin.from("affiliate_links").insert({
      affiliate_id: affiliateId,
      code,
      app_id: appId ?? null,
    });
    if (!error) return { code };
    if (!error.message.includes("unique")) throw error;
  }
  throw new Error("Failed to generate unique affiliate code after 5 attempts");
}

export async function getAffiliateLinks(affiliateId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("affiliate_links")
    .select("id, code, app_id, created_at")
    .eq("affiliate_id", affiliateId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function validateAffiliateCode(
  code: string
): Promise<{ affiliate_id: string; app_id: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("affiliate_links")
    .select("affiliate_id, app_id")
    .eq("code", code)
    .maybeSingle();
  return data ?? null;
}

export type AffiliateStatRow = {
  app_id: string;
  active_subs: number;
  mrr_gross_cents: number;
};

export async function getAffiliateStats(): Promise<AffiliateStatRow[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("affiliate_stats");
  if (error) throw error;
  return (data ?? []) as AffiliateStatRow[];
}

export async function recordAttribution({
  subscriptionId,
  affiliateId,
  code,
}: {
  subscriptionId: string;
  affiliateId: string;
  code: string;
}): Promise<void> {
  const admin = createAdminClient();
  // UNIQUE(subscription_id) makes this idempotent
  const { error } = await admin.from("affiliate_attributions").upsert(
    {
      subscription_id: subscriptionId,
      affiliate_id: affiliateId,
      code,
    },
    { onConflict: "subscription_id", ignoreDuplicates: true }
  );
  if (error) throw new Error(`Failed to record attribution: ${error.message}`);
}
