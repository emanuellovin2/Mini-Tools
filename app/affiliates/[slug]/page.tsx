import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getAffiliatePublicProfile,
  getEarnedBadges,
  getTopAppsPromoted,
} from "@/lib/services/affiliate";

function roundMrr(cents: number): string {
  if (cents <= 0) return "$0";
  const dollars = cents / 100;
  if (dollars < 100) return "<$100";
  const rounded = Math.round(dollars / 100) * 100;
  if (rounded >= 1_000) return `$${(rounded / 1_000).toFixed(rounded % 1_000 === 0 ? 0 : 1)}k`;
  return `$${rounded}`;
}

function tenureLabel(createdAt: string): string {
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const profile = await getAffiliatePublicProfile(slug);
  if (!profile) return { title: "Affiliate Not Found" };
  return { title: `${profile.display_name ?? slug} — [PLATFORM] Affiliate` };
}

export default async function AffiliateProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [profile, badges, topApps] = await Promise.all([
    getAffiliatePublicProfile(slug),
    getEarnedBadges("").catch(() => []), // resolved below once we have the id
    Promise.resolve([]),
  ]);

  if (!profile) notFound();

  const [earnedBadges, apps] = await Promise.all([
    getEarnedBadges(profile.id),
    getTopAppsPromoted(profile.id),
  ]);

  return (
    <main className="max-w-2xl mx-auto px-4 py-10 space-y-8">
      {/* Header */}
      <div className="flex items-start gap-4">
        {profile.affiliate_avatar_url ? (
          <img
            src={profile.affiliate_avatar_url}
            alt={profile.display_name ?? slug}
            className="w-16 h-16 rounded-full object-cover border border-gray-200"
          />
        ) : (
          <div className="w-16 h-16 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center text-2xl font-bold text-gray-700">
            {(profile.display_name ?? slug).charAt(0).toUpperCase()}
          </div>
        )}
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {profile.display_name ?? slug}
          </h1>
          <p className="text-sm text-gray-700">@{slug}</p>
          {profile.affiliate_bio && (
            <p className="text-sm text-gray-600 mt-1">{profile.affiliate_bio}</p>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <p className="text-xs text-gray-700">Active MRR</p>
          <p className="text-lg font-bold text-gray-900 mt-1">
            {roundMrr(profile.affiliate_active_mrr_cents)}
          </p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <p className="text-xs text-gray-700">Lifetime MRR</p>
          <p className="text-lg font-bold text-gray-900 mt-1">
            {roundMrr(profile.affiliate_lifetime_mrr_cents)}
          </p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <p className="text-xs text-gray-700">Tenure</p>
          <p className="text-lg font-bold text-gray-900 mt-1">
            {tenureLabel(profile.created_at)}
          </p>
        </div>
      </div>

      {/* Badges */}
      {earnedBadges.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Badges</h2>
          <div className="flex flex-wrap gap-2">
            {earnedBadges.map((badge) => (
              <div
                key={badge.id}
                title={badge.description}
                className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-full px-3 py-1 text-sm"
              >
                <span>{badge.icon_emoji}</span>
                <span className="font-medium text-gray-700">{badge.display_name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top apps promoted */}
      {apps.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Top Apps Promoted</h2>
          <div className="space-y-2">
            {apps.map((app) => (
              <div key={app.app_id} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">{app.app_name}</span>
                <span className="text-gray-700">{app.active_subs} active sub{app.active_subs !== 1 ? "s" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-gray-700 text-center">
        MRR figures are rounded for privacy. No buyer data is shown.
      </p>
    </main>
  );
}
