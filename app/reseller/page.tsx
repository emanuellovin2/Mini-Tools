import { redirect } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getResellerSubscription, getOffers, getResellerDashboard } from "@/lib/services/reseller";

export const metadata: Metadata = { title: "Reseller Dashboard — [PLATFORM]" };

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  trialing: "bg-blue-100 text-blue-700",
  past_due: "bg-yellow-100 text-yellow-700",
  canceled: "bg-red-100 text-red-700",
  unpaid: "bg-red-100 text-red-700",
  paused: "bg-gray-100 text-gray-700",
  draft: "bg-gray-100 text-gray-700",
};

const OFFER_STATUS_BADGE: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  draft: "bg-gray-100 text-gray-700",
  paused: "bg-yellow-100 text-yellow-700",
};

export default async function ResellerDashboard({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string; onboard?: string }>;
}) {
  const { setup, onboard } = await searchParams;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, slug, stripe_account_id, charges_enabled, payouts_enabled, display_name")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "reseller") redirect("/login");

  const [resSub, offers, dashboard] = await Promise.all([
    getResellerSubscription(user.id),
    getOffers(user.id),
    getResellerDashboard(user.id),
  ]);

  const isActive = resSub?.status === "active" || resSub?.status === "trialing";

  // Redirect to setup if not yet configured
  if (!profile.slug || !resSub) redirect("/reseller/setup");

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-lg font-semibold mb-6">Reseller Dashboard</h1>

        {(setup === "success" || onboard === "success") && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            {setup === "success" ? "Subscription activated!" : "Stripe Connect onboarding complete!"}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column */}
          <div className="space-y-4">
            {/* Billing status */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="font-semibold mb-3">Reseller Plan</h2>
              {resSub ? (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span>Status:</span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[resSub.status] ?? "bg-gray-100"}`}
                    >
                      {resSub.status}
                    </span>
                  </div>
                  <p className="text-gray-700 text-xs">
                    Renews:{" "}
                    {new Date(resSub.current_period_end).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                  {!isActive && (
                    <p className="text-yellow-700 text-xs">
                      New sales and offers are paused until your subscription is renewed.
                    </p>
                  )}
                </div>
              ) : (
                <Link
                  href="/reseller/setup"
                  className="text-sm text-blue-600 hover:underline"
                >
                  Complete setup →
                </Link>
              )}
            </div>

            {/* Connect status */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="font-semibold mb-3">Stripe Payouts</h2>
              {profile.payouts_enabled ? (
                <p className="text-sm text-green-600">Payouts enabled ✓</p>
              ) : (
                <div>
                  <p className="text-sm text-gray-700 mb-3">
                    Complete Stripe Connect onboarding to receive payouts.
                  </p>
                  <a
                    href="/api/reseller/connect"
                    className="inline-block px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
                  >
                    Set up payouts
                  </a>
                </div>
              )}
            </div>

            {/* Storefront link */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="font-semibold mb-2">Your Storefront</h2>
              <p className="text-sm text-gray-700 font-mono">/r/{profile.slug}</p>
            </div>
          </div>

          {/* Right column */}
          <div className="lg:col-span-2 space-y-6">
            {/* Stats */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl border border-gray-200 p-5">
                <p className="text-xs text-gray-700 mb-1">Active subscriptions</p>
                <p className="text-2xl font-bold">{dashboard.activeSubs}</p>
              </div>
              <div className="bg-white rounded-2xl border border-gray-200 p-5">
                <p className="text-xs text-gray-700 mb-1">Est. MRR (your share)</p>
                <p className="text-2xl font-bold">{formatCents(dashboard.mrrCents)}</p>
              </div>
            </div>

            {/* Offers */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold">Offers ({offers.length})</h2>
                {isActive && (
                  <Link
                    href="/reseller/offers"
                    className="text-sm text-blue-600 hover:underline"
                  >
                    Manage offers →
                  </Link>
                )}
              </div>
              {offers.length === 0 ? (
                <p className="text-sm text-gray-700">
                  No offers yet.{" "}
                  {isActive && profile.payouts_enabled ? (
                    <Link href="/reseller/offers" className="text-blue-600 hover:underline">
                      Create your first offer
                    </Link>
                  ) : (
                    "Complete setup to create offers."
                  )}
                </p>
              ) : (
                <div className="space-y-3">
                  {offers.map((offer) => {
                    const app = offer.apps as { name: string } | null;
                    return (
                      <div
                        key={offer.id}
                        className="flex items-center justify-between p-3 border border-gray-100 rounded-xl text-sm"
                      >
                        <div>
                          <p className="font-medium">{app?.name ?? "—"}</p>
                          <p className="text-xs text-gray-700">
                            {formatCents(offer.sell_price_cents)}/mo · floor{" "}
                            {formatCents(offer.vendor_floor_snapshot_cents)}
                          </p>
                        </div>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium ${OFFER_STATUS_BADGE[offer.status] ?? "bg-gray-100"}`}
                        >
                          {offer.status}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
    </div>
  );
}
