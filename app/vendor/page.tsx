import { redirect } from "next/navigation";
import Image from "next/image";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  getVendorApps,
  getVendorStats,
  aggregateStats,
  type VendorApp,
  type VendorSubscriptionStat,
} from "@/lib/services/vendor";
import AppForm from "./_components/AppForm";
import AffiliateCommissionForm from "./_components/AffiliateCommissionForm";
import ProfileForm from "./_components/ProfileForm";
import StripeConnect from "./_components/StripeConnect";

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

export default async function VendorDashboard() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, display_name, stripe_account_id, charges_enabled, payouts_enabled")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "vendor") redirect("/login");

  const [apps, stats] = await Promise.all([
    getVendorApps(user.id),
    getVendorStats(),
  ]);

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
