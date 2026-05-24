import { redirect } from "next/navigation";
import Image from "next/image";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  getVendorApps,
  getVendorStats,
  aggregateStats,
  getVendorMRR,
  getVendorMRRWaterfall,
  getVendorChurnRate,
  getVendorCohortRetention,
  getVendorLTV,
  type VendorApp,
  type VendorSubscriptionStat,
} from "@/lib/services/vendor";
import { getVendorCutBps } from "@/lib/stripe/transfers";
import AppForm from "./_components/AppForm";
import AffiliateCommissionForm from "./_components/AffiliateCommissionForm";
import ProfileForm from "./_components/ProfileForm";
import ResellerOpennessForm from "./_components/ResellerOpennessForm";
import StripeConnect from "./_components/StripeConnect";
import MRRCard from "./_components/MRRCard";
import MRRWaterfallChart from "./_components/MRRWaterfallChart";
import CohortRetentionTable from "./_components/CohortRetentionTable";
import ChurnRateCard from "./_components/ChurnRateCard";
import LTVCard from "./_components/LTVCard";

export const metadata: Metadata = { title: "Vendor Dashboard — [PLATFORM]" };

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function AppRow({
  app,
  stats,
}: {
  app: VendorApp;
  stats: VendorSubscriptionStat[];
}) {
  const { activeCount, mrrCents } = aggregateStats(app.id, stats);

  return (
    <div className="flex items-start gap-4 p-4 border border-gray-100 rounded-xl">
      {app.logo_url ? (
        <Image
          src={app.logo_url}
          alt={app.name}
          width={40}
          height={40}
          className="rounded-lg object-cover shrink-0"
        />
      ) : (
        <div className="w-10 h-10 rounded-lg bg-gray-100 shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{app.name}</span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[app.status] ?? "bg-gray-100 text-gray-500"}`}
          >
            {app.status}
          </span>
          {app.category && (
            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
              {app.category}
            </span>
          )}
        </div>

        <div className="mt-1 flex items-center gap-4 text-xs text-gray-500 flex-wrap">
          <span>{formatCents(app.price_cents)}/mo</span>
          {app.min_price_cents != null && (
            <span className="text-gray-400">
              floor {formatCents(app.min_price_cents)}/mo (resellable)
            </span>
          )}
          {app.affiliate_commission_bps != null && (
            <span className="text-gray-400">
              affiliate {app.affiliate_commission_bps / 100}%
            </span>
          )}
          <span>{activeCount} active subscriber{activeCount === 1 ? "" : "s"}</span>
          <span>MRR {formatCents(mrrCents)}</span>
        </div>
        <AffiliateCommissionForm appId={app.id} currentBps={app.affiliate_commission_bps} />
      </div>
    </div>
  );
}

function EarningsSummary({ stats }: { stats: VendorSubscriptionStat[] }) {
  const active = stats.filter(
    (s) => s.status === "active" || s.status === "trialing"
  );
  const totalMrr = active.reduce((sum, s) => sum + s.price_cents, 0);

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="bg-gray-50 rounded-xl p-4">
        <p className="text-xs text-gray-500 mb-1">Active subscribers</p>
        <p className="text-2xl font-bold">{active.length}</p>
      </div>
      <div className="bg-gray-50 rounded-xl p-4">
        <p className="text-xs text-gray-500 mb-1">Est. MRR (gross)</p>
        <p className="text-2xl font-bold">{formatCents(totalMrr)}</p>
        <p className="text-xs text-gray-400 mt-1">Stripe earnings wire up in #5–#7</p>
      </div>
    </div>
  );
}

export default async function VendorDashboard({
  searchParams,
}: {
  searchParams: Promise<{ app?: string }>;
}) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = (await import("@/lib/services/supabase")).createAdminClient();
  type VendorProfile = { role: string; display_name: string | null; stripe_account_id: string | null; charges_enabled: boolean | null; payouts_enabled: boolean | null; vendor_cut_bps_override: number | null; reseller_openness: string | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: profile } = await (admin as any)
    .from("profiles")
    .select("role, display_name, stripe_account_id, charges_enabled, payouts_enabled, vendor_cut_bps_override, reseller_openness")
    .eq("id", user.id)
    .single() as { data: VendorProfile | null };

  if (profile?.role !== "vendor") redirect("/login");

  const { app: selectedAppId } = await searchParams;
  const appFilter = selectedAppId || undefined;

  const [apps, stats, mrr, waterfall, cohort, ltv, effectiveCutBps] = await Promise.all([
    getVendorApps(user.id),
    getVendorStats(),
    getVendorMRR(user.id, appFilter),
    getVendorMRRWaterfall(user.id, 6, appFilter),
    getVendorCohortRetention(user.id),
    getVendorLTV(user.id),
    getVendorCutBps(user.id),
  ]);

  // Trailing 3-month average churn for the ChurnRateCard
  const now = new Date();
  const [c1, c2, c3] = await Promise.all([
    getVendorChurnRate(user.id, now, appFilter),
    getVendorChurnRate(user.id, new Date(now.getFullYear(), now.getMonth() - 1, 1), appFilter),
    getVendorChurnRate(user.id, new Date(now.getFullYear(), now.getMonth() - 2, 1), appFilter),
  ]);
  const trailing3Bps = Math.round((c1 + c2 + c3) / 3);

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Vendor Dashboard</h1>
            <p className="text-sm text-gray-500 mt-0.5">{user.email}</p>
          </div>
          <form action="/api/auth/signout" method="POST">
            <button
              type="submit"
              className="text-sm text-gray-500 hover:text-red-600 transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column */}
          <div className="space-y-4">
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="font-semibold mb-4">Profile</h2>
              <ProfileForm currentDisplayName={profile.display_name ?? ""} />
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="font-semibold mb-3">Platform Cut</h2>
              {profile.vendor_cut_bps_override != null ? (
                <div>
                  <span className="inline-block text-xs px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200 font-medium">
                    Custom rate {(effectiveCutBps / 100).toFixed(2)}% (set by admin)
                  </span>
                  <p className="text-xs text-gray-400 mt-1">
                    This overrides the standard tier pricing.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-gray-600">
                  {effectiveCutBps <= 300 ? "Tier 4" :
                   effectiveCutBps <= 500 ? "Tier 3" :
                   effectiveCutBps <= 800 ? "Tier 2" : "Tier 1"}{" "}
                  — {(effectiveCutBps / 100).toFixed(2)}%
                </p>
              )}
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="font-semibold mb-1">Reseller Openness</h2>
              <p className="text-xs text-gray-400 mb-3">
                Controls whether resellers can list or white-label your app.
              </p>
              <ResellerOpennessForm
                current={(profile.reseller_openness ?? "open_to_resellers") as "closed" | "open_to_resellers" | "open_to_wl"}
              />
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="font-semibold mb-3">Stripe Payments</h2>
              <StripeConnect
                stripeAccountId={profile.stripe_account_id ?? null}
                chargesEnabled={profile.charges_enabled ?? false}
                payoutsEnabled={profile.payouts_enabled ?? false}
              />
            </div>
          </div>

          {/* Right column */}
          <div className="lg:col-span-2 space-y-6">
            {/* ── Analytics ─────────────────────────────────────────────── */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold">Analytics</h2>
                {/* Per-app filter */}
                <form method="GET">
                  <select
                    name="app"
                    defaultValue={selectedAppId ?? ""}
                    onChange={(e) => {
                      (e.currentTarget.form as HTMLFormElement).submit();
                    }}
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-300"
                  >
                    <option value="">All apps</option>
                    {apps.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <noscript>
                    <button type="submit" className="ml-2 text-xs underline">
                      Filter
                    </button>
                  </noscript>
                </form>
              </div>

              {/* KPI cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                <MRRCard snapshot={mrr} waterfall={waterfall} />
                <ChurnRateCard churnBps={c1} trailing3Bps={trailing3Bps} />
                <LTVCard ltv={ltv} />
              </div>

              {/* MRR waterfall bar chart */}
              <div className="mb-6">
                <p className="text-xs font-medium text-gray-500 mb-3">
                  New vs Churned MRR — last 6 months
                </p>
                <MRRWaterfallChart data={waterfall} />
              </div>

              {/* Cohort retention heatmap */}
              <div>
                <p className="text-xs font-medium text-gray-500 mb-3">
                  Cohort retention
                </p>
                <CohortRetentionTable rows={cohort} />
              </div>

              <p className="text-xs text-gray-400 mt-4">
                MRR includes direct + affiliate subs. Reseller-sold subs counted at vendor floor.{" "}
                <a
                  href="#methodology"
                  className="underline hover:text-gray-600"
                  id="methodology"
                >
                  Methodology
                </a>
                : MRR = sum of active subscription prices; LTV = avg price ÷ monthly churn rate.
              </p>
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="font-semibold mb-4">Earnings</h2>
              <EarningsSummary stats={stats} />
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="font-semibold mb-4">
                My Apps{" "}
                <span className="text-gray-400 font-normal text-sm">
                  ({apps.length})
                </span>
              </h2>
              {apps.length === 0 ? (
                <p className="text-sm text-gray-400">
                  No apps yet. Submit one below.
                </p>
              ) : (
                <div className="space-y-3">
                  {apps.map((app) => (
                    <AppRow
                      key={app.id}
                      app={app}
                      stats={stats}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="font-semibold mb-4">Submit New App</h2>
              <AppForm />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
