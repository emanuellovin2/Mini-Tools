import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import {
  getAffiliateLinks,
  getAffiliateStats,
  getAffiliateLeaderboardPosition,
  getBadgeProgress,
  getAllBadges,
} from "@/lib/services/affiliate";
import GenerateLinkForm from "./_components/GenerateLinkForm";
import LinksList from "./_components/LinksList";
import ProfileEditor from "./_components/ProfileEditor";

export const metadata: Metadata = { title: "Affiliate Dashboard — [PLATFORM]" };

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Next badge the affiliate hasn't earned yet, with how much more is needed.
function nextBadgeProgress(
  profile: { affiliate_lifetime_mrr_cents: number; affiliate_active_mrr_cents: number; created_at: string },
  badgesWithStatus: Array<{ id: string; display_name: string; threshold_kind: string; threshold_value: number; icon_emoji: string | null; earned: boolean }>
): { badge: typeof badgesWithStatus[0]; remaining: string } | null {
  const tenureDays = (Date.now() - new Date(profile.created_at).getTime()) / 86_400_000;
  const unearned = badgesWithStatus.filter((b) => !b.earned);
  if (unearned.length === 0) return null;

  for (const b of unearned) {
    let remaining: string | null = null;
    if (b.threshold_kind === "lifetime_mrr") {
      const diff = b.threshold_value - profile.affiliate_lifetime_mrr_cents;
      if (diff > 0) remaining = `$${(diff / 100).toFixed(0)} more lifetime MRR`;
    } else if (b.threshold_kind === "active_mrr") {
      const diff = b.threshold_value - profile.affiliate_active_mrr_cents;
      if (diff > 0) remaining = `$${(diff / 100).toFixed(0)} more active MRR`;
    } else if (b.threshold_kind === "tenure_days") {
      const diff = Math.ceil(b.threshold_value - tenureDays);
      if (diff > 0) remaining = `${diff} more day${diff !== 1 ? "s" : ""} as affiliate`;
    }
    if (remaining !== null) return { badge: b, remaining };
  }
  return null;
}

export default async function AffiliateDashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, stripe_account_id, charges_enabled, payouts_enabled, display_name, slug, affiliate_bio, affiliate_avatar_url, affiliate_active_mrr_cents, affiliate_lifetime_mrr_cents, created_at")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "affiliate") redirect("/buyer");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const admin = createAdminClient();

  const [links, stats, position, badgesWithStatus] = await Promise.all([
    getAffiliateLinks(user.id),
    getAffiliateStats(),
    getAffiliateLeaderboardPosition(user.id),
    getBadgeProgress(user.id),
  ]);

  // Look up app names for stats rows
  const appIds = [...new Set(stats.map((s) => s.app_id))];
  const appNames: Record<string, string> = {};
  if (appIds.length > 0) {
    const { data: apps } = await admin
      .from("apps")
      .select("id, name")
      .in("id", appIds);
    for (const app of apps ?? []) appNames[app.id] = app.name;
  }

  const totalActiveSubs = stats.reduce((s, r) => s + Number(r.active_subs), 0);
  const totalMrrCents = stats.reduce((s, r) => s + Number(r.mrr_gross_cents ?? 0), 0);

  const onboardingDone = profile.charges_enabled && profile.payouts_enabled;

  const profileForBadges = {
    affiliate_lifetime_mrr_cents: profile.affiliate_lifetime_mrr_cents ?? 0,
    affiliate_active_mrr_cents: profile.affiliate_active_mrr_cents ?? 0,
    created_at: profile.created_at,
  };
  const nextBadge = nextBadgeProgress(profileForBadges, badgesWithStatus);
  const earnedBadges = badgesWithStatus.filter((b) => b.earned);

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <h1 className="text-lg font-semibold">Affiliate Dashboard</h1>

      {/* Stripe Connect onboarding */}
      {!onboardingDone && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <p className="text-sm font-medium text-amber-800">
            Complete Stripe Connect onboarding to receive payouts.
          </p>
          <a
            href="/api/affiliate/onboard"
            className="inline-block mt-2 bg-amber-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-amber-700 transition-colors"
          >
            Connect Stripe Account
          </a>
        </div>
      )}

      {/* Leaderboard rank + badge progress */}
      {(position || earnedBadges.length > 0 || nextBadge) && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          {position && (
            <p className="text-sm text-gray-700">
              You&apos;re{" "}
              <span className="font-semibold">#{position.active_rank}</span> on the{" "}
              <Link href="/affiliates/top" className="underline hover:text-blue-600">
                active MRR leaderboard
              </Link>
            </p>
          )}
          {earnedBadges.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {earnedBadges.map((b) => (
                <div
                  key={b.id}
                  title={b.description}
                  className="flex items-center gap-1 bg-gray-50 border border-gray-200 rounded-full px-2.5 py-0.5 text-xs"
                >
                  <span>{b.icon_emoji}</span>
                  <span className="font-medium text-gray-700">{b.display_name}</span>
                </div>
              ))}
            </div>
          )}
          {nextBadge && (
            <p className="text-xs text-gray-700">
              Next badge:{" "}
              <span className="font-medium text-gray-700">
                {nextBadge.badge.icon_emoji} {nextBadge.badge.display_name}
              </span>{" "}
              — {nextBadge.remaining} to go
            </p>
          )}
        </div>
      )}

      {/* Aggregate stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-700">Active Attributed Subscribers</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totalActiveSubs}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-700">Estimated MRR Earned</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatCents(totalMrrCents)}</p>
          <p className="text-xs text-gray-700 mt-0.5">Based on active subscriber prices</p>
        </div>
      </div>

      {/* Per-app breakdown */}
      {stats.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700">By App</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-700 border-b border-gray-100">
                <th className="text-left px-4 py-2 font-medium">App</th>
                <th className="text-right px-4 py-2 font-medium">Active Subs</th>
                <th className="text-right px-4 py-2 font-medium">Est. MRR Earned</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {stats.map((row) => (
                <tr key={row.app_id}>
                  <td className="px-4 py-2 text-gray-700">
                    {appNames[row.app_id] ?? row.app_id}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-700">
                    {Number(row.active_subs)}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-700">
                    {formatCents(Number(row.mrr_gross_cents ?? 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Public profile editor */}
      <ProfileEditor
        currentSlug={profile.slug ?? null}
        currentBio={profile.affiliate_bio ?? null}
        currentAvatarUrl={profile.affiliate_avatar_url ?? null}
      />

      {/* Generate new link */}
      <GenerateLinkForm />

      {/* Existing links */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Your Referral Links</h2>
        <LinksList links={links} appUrl={appUrl} />
      </div>
    </div>
  );
}
