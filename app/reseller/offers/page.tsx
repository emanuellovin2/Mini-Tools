import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getResellerSubscription, getOffers, getResellableApps } from "@/lib/services/reseller";
import CreateOfferForm from "./_components/CreateOfferForm";
import OfferStatusButton from "./_components/OfferStatusButton";

export const metadata: Metadata = { title: "Reseller Offers — [PLATFORM]" };

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

const OFFER_STATUS_BADGE: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  draft: "bg-gray-100 text-gray-500",
  paused: "bg-yellow-100 text-yellow-700",
};

export default async function OffersPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, slug, payouts_enabled")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "reseller") redirect("/login");

  const [resSub, offers, resellableApps] = await Promise.all([
    getResellerSubscription(user.id),
    getOffers(user.id),
    getResellableApps(user.id),
  ]);

  const isActive = resSub?.status === "active" || resSub?.status === "trialing";
  const canPublish = isActive && !!profile.payouts_enabled;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-10">
        <div className="flex items-center gap-3 mb-6">
          <a href="/reseller" className="text-sm text-gray-500 hover:text-gray-700">
            ← Dashboard
          </a>
          <h1 className="text-2xl font-bold">My Offers</h1>
        </div>

        {!canPublish && (
          <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-700">
            {!isActive
              ? "Your reseller subscription is inactive. Renew to publish new offers."
              : "Complete Stripe Connect onboarding to publish offers."}
          </div>
        )}

        {/* Existing offers */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold mb-4">Existing Offers ({offers.length})</h2>
          {offers.length === 0 ? (
            <p className="text-sm text-gray-400">No offers yet. Create one below.</p>
          ) : (
            <div className="space-y-3">
              {offers.map((offer) => {
                const app = offer.apps as { name: string } | null;
                return (
                  <div
                    key={offer.id}
                    className="flex items-center justify-between p-4 border border-gray-100 rounded-xl"
                  >
                    <div>
                      <p className="font-medium text-sm">{app?.name ?? "—"}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {formatCents(offer.sell_price_cents)}/mo · floor{" "}
                        {formatCents(offer.vendor_floor_snapshot_cents)} · slug: /{offer.slug}
                      </p>
                      {profile.slug && (
                        <p className="text-xs text-blue-600 mt-0.5">
                          /r/{profile.slug}/{offer.slug}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${OFFER_STATUS_BADGE[offer.status] ?? "bg-gray-100"}`}
                      >
                        {offer.status}
                      </span>
                      <OfferStatusButton offer={offer} canPublish={canPublish} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Create new offer */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="font-semibold mb-4">Create New Offer</h2>
          {resellableApps.length === 0 ? (
            <p className="text-sm text-gray-400">
              No resellable apps available. Vendors must opt in by setting a minimum price.
            </p>
          ) : (
            <CreateOfferForm apps={resellableApps} />
          )}
        </div>
      </div>
    </main>
  );
}
