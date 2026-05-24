import { createAdminClient } from "./supabase";
import { createServerSupabaseClient } from "./supabase-server";
import { getStripe } from "@/lib/stripe/client";

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

// ── Dashboard v2 types & helpers (#33) ──────────────────────────────────────

export type AffiliateFunnel = {
  total_attributed: number;
  currently_active: number;
  active_30d: number;   // created ≥30d ago, still active
  active_90d: number;   // created ≥90d ago, still active
};

export type EarningsByAppRow = {
  app_id: string;
  app_name: string;
  commission_bps: number;
  sale_count: number;       // all time active subs
  earnings_cents: number;   // estimated: price * commission_bps / 10000
  avg_per_sale_cents: number;
};

export type AffiliatePayoutRow = {
  id: string;
  amount_cents: number;
  currency: string;
  arrival_date: string;
  status: string;
};

export type PendingEarnings = {
  confirmed_cents: number;    // subs >30d old — past typical clawback window
  in_clawback_cents: number;  // subs ≤30d old — still at risk of refund
};

export type ClawbackRow = {
  id: string;
  date: string;
  amount_cents: number;
  description: string;
};

export type AffiliateRetention = {
  original_count: number;   // subs created ≥6 months ago
  active_now: number;       // of those, still active
  retention_pct: number;
};

export type PromotableApp = {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  category: string | null;
  affiliate_commission_bps: number;
  screenshot_urls: string[];
  logo_url: string | null;
};

// Conversion funnel: attributed subs at each stage, optionally filtered by link code.
export async function getAffiliateFunnel(
  affiliateId: string,
  linkCode?: string
): Promise<AffiliateFunnel> {
  const admin = createAdminClient();
  const now = new Date();
  const t30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const t90 = new Date(now.getTime() - 90 * 86_400_000).toISOString();

  let query = admin
    .from("subscriptions")
    .select("id, status, created_at, affiliate_links!inner(code, affiliate_id)")
    .eq("affiliate_links.affiliate_id", affiliateId);

  if (linkCode) query = query.eq("affiliate_links.code", linkCode);

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  const active = rows.filter(
    (r) => r.status === "active" || r.status === "trialing"
  );

  return {
    total_attributed: rows.length,
    currently_active: active.length,
    active_30d: active.filter((r) => r.created_at <= t30).length,
    active_90d: active.filter((r) => r.created_at <= t90).length,
  };
}

// Earnings breakdown per app: commission estimate = price_cents × snapshot_bps / 10000.
export async function getAffiliateEarningsByApp(
  affiliateId: string
): Promise<EarningsByAppRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("subscriptions")
    .select(
      "app_id, price_cents, affiliate_commission_snapshot_bps, status, apps!inner(name)"
    )
    .eq("affiliate_id", affiliateId)
    .in("status", ["active", "trialing"]);
  if (error) throw error;

  const byApp = new Map<
    string,
    { app_name: string; commission_bps: number; sales: number; earnings: number }
  >();

  for (const row of data ?? []) {
    const bps = row.affiliate_commission_snapshot_bps ?? 0;
    const earn = Math.floor((row.price_cents * bps) / 10_000);
    const appName = (row.apps as unknown as { name: string }).name;
    const existing = byApp.get(row.app_id) ?? {
      app_name: appName,
      commission_bps: bps,
      sales: 0,
      earnings: 0,
    };
    byApp.set(row.app_id, {
      ...existing,
      sales: existing.sales + 1,
      earnings: existing.earnings + earn,
    });
  }

  return [...byApp.entries()]
    .map(([app_id, v]) => ({
      app_id,
      app_name: v.app_name,
      commission_bps: v.commission_bps,
      sale_count: v.sales,
      earnings_cents: v.earnings,
      avg_per_sale_cents: v.sales > 0 ? Math.round(v.earnings / v.sales) : 0,
    }))
    .sort((a, b) => b.earnings_cents - a.earnings_cents);
}

// Weekly payouts from the affiliate's Stripe Connect account.
export async function getAffiliatePayouts(
  affiliateId: string
): Promise<AffiliatePayoutRow[]> {
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", affiliateId)
    .maybeSingle();

  if (!profile?.stripe_account_id) return [];

  try {
    const stripe = getStripe();
    const payouts = await stripe.payouts.list(
      { limit: 10 },
      { stripeAccount: profile.stripe_account_id }
    );
    return payouts.data.map((p) => ({
      id: p.id,
      amount_cents: p.amount,
      currency: p.currency,
      arrival_date: new Date(p.arrival_date * 1000).toISOString(),
      status: p.status,
    }));
  } catch {
    return [];
  }
}

// Pending earnings: subs >30d old are "confirmed"; ≤30d old are still in clawback risk window.
export async function getAffiliatePendingEarnings(
  affiliateId: string
): Promise<PendingEarnings> {
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const { data, error } = await admin
    .from("subscriptions")
    .select("price_cents, affiliate_commission_snapshot_bps, created_at")
    .eq("affiliate_id", affiliateId)
    .in("status", ["active", "trialing"]);
  if (error) throw error;

  let confirmed = 0;
  let in_clawback = 0;

  for (const row of data ?? []) {
    const bps = row.affiliate_commission_snapshot_bps ?? 0;
    const earn = Math.floor((row.price_cents * bps) / 10_000);
    if (row.created_at <= cutoff) {
      confirmed += earn;
    } else {
      in_clawback += earn;
    }
  }

  return { confirmed_cents: confirmed, in_clawback_cents: in_clawback };
}

// Clawbacks from Stripe Connect balance (negative payment_refund transactions on affiliate's account).
export async function getAffiliateClawbacks(
  affiliateId: string,
  days = 30
): Promise<ClawbackRow[]> {
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", affiliateId)
    .maybeSingle();

  if (!profile?.stripe_account_id) return [];

  try {
    const stripe = getStripe();
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const txns = await stripe.balanceTransactions.list(
      { limit: 50, created: { gte: since }, type: "payment_refund" },
      { stripeAccount: profile.stripe_account_id }
    );
    return txns.data
      .filter((t) => t.amount < 0)
      .map((t) => ({
        id: t.id,
        date: new Date(t.created * 1000).toISOString(),
        amount_cents: Math.abs(t.amount),
        description: t.description ?? "Commission clawback",
      }));
  } catch {
    return [];
  }
}

// Sticky referrals: of subs created ≥6 months ago, how many are still active?
export async function getAffiliateRetention(
  affiliateId: string,
  monthsAgo = 6
): Promise<AffiliateRetention> {
  const admin = createAdminClient();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsAgo);
  const cutoffIso = cutoff.toISOString();

  const { data, error } = await admin
    .from("subscriptions")
    .select("status, created_at")
    .eq("affiliate_id", affiliateId)
    .lte("created_at", cutoffIso);
  if (error) throw error;

  const rows = data ?? [];
  const original_count = rows.length;
  const active_now = rows.filter(
    (r) => r.status === "active" || r.status === "trialing"
  ).length;
  const retention_pct =
    original_count > 0 ? Math.round((active_now / original_count) * 100) : 0;

  return { original_count, active_now, retention_pct };
}

// All approved apps with affiliate_commission_bps > 0, sorted by commission desc.
export async function getPromotableApps(): Promise<PromotableApp[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("apps")
    .select(
      "id, name, description, price_cents, category, affiliate_commission_bps, screenshot_urls, logo_url"
    )
    .eq("status", "approved")
    .not("affiliate_commission_bps", "is", null)
    .gt("affiliate_commission_bps", 0)
    .order("affiliate_commission_bps", { ascending: false });
  if (error) throw error;
  return (data ?? []) as PromotableApp[];
}
