import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { getAffiliateLinks, getAffiliateStats } from "@/lib/services/affiliate";
import GenerateLinkForm from "./_components/GenerateLinkForm";
import LinksList from "./_components/LinksList";

export const metadata: Metadata = { title: "Affiliate Dashboard — [PLATFORM]" };

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function AffiliateDashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, stripe_account_id, charges_enabled, payouts_enabled, display_name")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "affiliate") redirect("/buyer");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const admin = createAdminClient();

  const [links, stats] = await Promise.all([
    getAffiliateLinks(user.id),
    getAffiliateStats(),
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

  return (
    <main className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Affiliate Dashboard</h1>
        {profile.display_name && (
          <p className="text-sm text-gray-500 mt-1">{profile.display_name}</p>
        )}
      </div>

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

      {/* Aggregate stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-500">Active Attributed Subscribers</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totalActiveSubs}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-500">Estimated MRR Earned</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatCents(totalMrrCents)}</p>
          <p className="text-xs text-gray-400 mt-0.5">Based on active subscriber prices</p>
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
              <tr className="text-xs text-gray-400 border-b border-gray-100">
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

      {/* Generate new link */}
      <GenerateLinkForm />

      {/* Existing links */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Your Referral Links</h2>
        <LinksList links={links} appUrl={appUrl} />
      </div>
    </main>
  );
}
