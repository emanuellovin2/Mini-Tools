import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import GlobalBrandingForm from "./_components/GlobalBrandingForm";

export const metadata: Metadata = { title: "Brand Settings — [PLATFORM]" };

export default async function ResellerBrandPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  type ProfileWithBranding = { role: string; wl_global_logo_url: string | null; wl_global_brand_color: string | null; wl_global_display_name: string | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: profile } = await (admin as any)
    .from("profiles")
    .select("role, wl_global_logo_url, wl_global_brand_color, wl_global_display_name")
    .eq("id", user.id)
    .single() as { data: ProfileWithBranding | null };

  if (!profile || profile.role !== "reseller") redirect("/login");

  const profileRecord = profile as ProfileWithBranding;
  const currentBranding = profileRecord.wl_global_logo_url
    ? {
        logoUrl: profileRecord.wl_global_logo_url,
        brandColor: profileRecord.wl_global_brand_color!,
        displayName: profileRecord.wl_global_display_name!,
      }
    : null;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-10">
        <div className="flex items-center gap-3 mb-6">
          <a href="/reseller" className="text-sm text-gray-500 hover:text-gray-700">
            ← Dashboard
          </a>
          <h1 className="text-2xl font-bold">Brand Settings</h1>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold mb-1">Tier 1 Global Mini-Branding</h2>
          <p className="text-sm text-gray-500 mb-4">
            Applied to all your storefront pages on the platform domain. Free with any active subscription.
            All three fields must be set together, or all cleared.
          </p>
          <GlobalBrandingForm currentBranding={currentBranding} />
        </div>

        <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4">
          <p className="text-sm text-blue-700">
            <strong>Want per-app branding?</strong> Upgrade individual offers to Tier 2 ($29/mo per offer)
            for subdomain storefronts, custom email branding, and Stripe Checkout branding.
            Go to <a href="/reseller/offers" className="underline">My Offers</a> to upgrade.
          </p>
        </div>
      </div>
    </main>
  );
}
