import { createAdminClient } from "./supabase";
import { createServerSupabaseClient } from "./supabase-server";

export type AffiliateBadge = {
  id: string;
  display_name: string;
  description: string;
  threshold_kind: string;
  threshold_value: number;
  icon_emoji: string | null;
  sort_order: number;
};

export type LeaderboardRow = {
  id: string;
  slug: string;
  display_name: string | null;
  affiliate_avatar_url: string | null;
  affiliate_active_mrr_cents: number;
  affiliate_lifetime_mrr_cents: number;
  tenure_days: number;
  active_rank: number;
  lifetime_rank: number;
};

export type PublicAffiliateProfile = {
  id: string;
  slug: string;
  display_name: string | null;
  affiliate_bio: string | null;
  affiliate_avatar_url: string | null;
  affiliate_active_mrr_cents: number;
  affiliate_lifetime_mrr_cents: number;
  created_at: string;
};

// Pure function mirroring the SQL badge derivation — used for tests and next-badge progress UI.
export function computeEarnedBadgeIds(
  profile: {
    affiliate_lifetime_mrr_cents: number;
    affiliate_active_mrr_cents: number;
    created_at: string;
  },
  badges: AffiliateBadge[]
): string[] {
  const tenureDays = (Date.now() - new Date(profile.created_at).getTime()) / 86_400_000;
  return badges
    .filter((b) => {
      if (b.threshold_kind === "lifetime_mrr") return profile.affiliate_lifetime_mrr_cents >= b.threshold_value;
      if (b.threshold_kind === "active_mrr")   return profile.affiliate_active_mrr_cents   >= b.threshold_value;
      if (b.threshold_kind === "tenure_days")  return tenureDays >= b.threshold_value;
      return false;
    })
    .map((b) => b.id);
}

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

export async function getAllBadges(): Promise<AffiliateBadge[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("affiliate_badges")
    .select("*")
    .order("sort_order");
  if (error) throw error;
  return (data ?? []) as AffiliateBadge[];
}

export async function getEarnedBadges(affiliateId: string): Promise<AffiliateBadge[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("affiliate_earned_badges", {
    p_affiliate_id: affiliateId,
  });
  if (error) throw error;
  return (data ?? []) as AffiliateBadge[];
}

export async function getBadgeProgress(
  affiliateId: string
): Promise<Array<AffiliateBadge & { earned: boolean }>> {
  const [allBadges, earnedBadges] = await Promise.all([
    getAllBadges(),
    getEarnedBadges(affiliateId),
  ]);
  const earnedIds = new Set(earnedBadges.map((b) => b.id));
  return allBadges.map((b) => ({ ...b, earned: earnedIds.has(b.id) }));
}

export async function getLeaderboard(limit = 50): Promise<LeaderboardRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("affiliate_leaderboard")
    .select("*")
    .order("affiliate_active_mrr_cents", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as LeaderboardRow[];
}

export async function getLeaderboardByLifetime(limit = 50): Promise<LeaderboardRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("affiliate_leaderboard")
    .select("*")
    .order("affiliate_lifetime_mrr_cents", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as LeaderboardRow[];
}

export async function getAffiliatePublicProfile(
  slug: string
): Promise<PublicAffiliateProfile | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select(
      "id, slug, display_name, affiliate_bio, affiliate_avatar_url, affiliate_active_mrr_cents, affiliate_lifetime_mrr_cents, created_at"
    )
    .eq("slug", slug)
    .eq("role", "affiliate")
    .neq("affiliate_lifetime_mrr_cents", 0)
    .maybeSingle();
  if (error) throw error;
  return data as PublicAffiliateProfile | null;
}

export async function getAffiliateLeaderboardPosition(
  affiliateId: string
): Promise<{ active_rank: number | null; lifetime_rank: number | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("affiliate_leaderboard")
    .select("active_rank, lifetime_rank")
    .eq("id", affiliateId)
    .maybeSingle();
  return data ?? null;
}

export async function getTopAppsPromoted(
  affiliateId: string
): Promise<Array<{ app_id: string; app_name: string; active_subs: number }>> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("subscriptions")
    .select("app_id, apps!inner(name)")
    .eq("affiliate_id", affiliateId)
    .in("status", ["active", "trialing"]);
  if (error) throw error;

  const agg: Record<string, { app_name: string; active_subs: number }> = {};
  for (const row of data ?? []) {
    const appId = row.app_id;
    const appName = (row.apps as unknown as { name: string }).name;
    if (!agg[appId]) agg[appId] = { app_name: appName, active_subs: 0 };
    agg[appId].active_subs++;
  }

  return Object.entries(agg)
    .map(([app_id, v]) => ({ app_id, ...v }))
    .sort((a, b) => b.active_subs - a.active_subs)
    .slice(0, 3);
}

export async function updateAffiliateProfile(
  affiliateId: string,
  updates: { bio?: string | null; avatar_url?: string | null; slug?: string | null }
): Promise<{ error?: string }> {
  const admin = createAdminClient();
  const patch: {
    affiliate_bio?: string | null;
    affiliate_avatar_url?: string | null;
    slug?: string | null;
  } = {};
  if ("bio" in updates) patch.affiliate_bio = updates.bio ?? null;
  if ("avatar_url" in updates) patch.affiliate_avatar_url = updates.avatar_url ?? null;
  if ("slug" in updates) patch.slug = updates.slug ?? null;

  const { error } = await admin.from("profiles").update(patch).eq("id", affiliateId);
  if (error) {
    if (error.message.includes("unique") || error.message.includes("duplicate")) {
      return { error: "That slug is already taken. Choose a different one." };
    }
    return { error: error.message };
  }
  return {};
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
