import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import UpgradeWLForm from "./_components/UpgradeWLForm";

export const metadata: Metadata = { title: "Upgrade to White-Label Tier 2 — [PLATFORM]" };

export default async function UpgradeWLPage({
  params,
}: {
  params: Promise<{ offerId: string }>;
}) {
  const { offerId } = await params;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "reseller") redirect("/login");

  const admin = createAdminClient();
  type OfferWithApp = {
    id: string;
    slug: string;
    wl_tier: number;
    wl_status: string | null;
    apps: { name: string; profiles: { reseller_openness: string } | null } | null;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: offer } = await (admin as any)
    .from("reseller_offers")
    .select("id, slug, wl_tier, wl_status, apps (name, profiles!apps_vendor_id_fkey (reseller_openness))")
    .eq("id", offerId)
    .eq("reseller_id", user.id)
    .maybeSingle() as { data: OfferWithApp | null };

  if (!offer) notFound();

  const vendorOpenness = (offer.apps as OfferWithApp["apps"])?.profiles?.reseller_openness;
  const vendorAllowsWL = vendorOpenness === "open_to_wl";
  const alreadyTier2 = offer.wl_tier === 2 && (offer.wl_status === "active" || offer.wl_status === "trialing");

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-xl mx-auto px-4 py-10">
        <div className="flex items-center gap-3 mb-6">
          <a href="/reseller/offers" className="text-sm text-gray-700 hover:text-gray-900">
            ← My Offers
          </a>
          <h1 className="text-2xl font-bold">Upgrade to White-Label Tier 2</h1>
        </div>

        {alreadyTier2 ? (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-6 text-green-800">
            <p className="font-semibold">This offer already has Tier 2 active.</p>
            <a href="/reseller/offers" className="text-sm underline mt-2 inline-block">Back to offers</a>
          </div>
        ) : !vendorAllowsWL ? (
          <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-6 text-yellow-800">
            <p className="font-semibold">The vendor has not enabled white-label for this app.</p>
            <p className="text-sm mt-1">White-label Tier 2 is only available when the app vendor has opted in.</p>
            <a href="/reseller/offers" className="text-sm underline mt-2 inline-block">Back to offers</a>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="mb-4">
              <h2 className="font-semibold">{offer.apps?.name}</h2>
              <p className="text-sm text-gray-700 mt-1">
                Tier 2 costs <strong>$29/mo</strong> per offer. You get: subdomain storefront
                (<code className="text-xs bg-gray-100 px-1 rounded">your-slug.platform.com</code>), custom logo
                + brand color in the storefront header, and branded email receipts.
              </p>
            </div>
            <UpgradeWLForm offerId={offerId} />
          </div>
        )}
      </div>
    </main>
  );
}
