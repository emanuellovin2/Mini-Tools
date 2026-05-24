import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getResellerSubscription } from "@/lib/services/reseller";
import SetupForm from "./_components/SetupForm";

export const metadata: Metadata = { title: "Reseller Setup — [PLATFORM]" };

export default async function ResellerSetupPage() {
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

  // If already fully set up, go to dashboard
  const resSub = await getResellerSubscription(user.id);
  const isActive = resSub?.status === "active" || resSub?.status === "trialing";
  if (profile.slug && isActive) redirect("/reseller");

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl border border-gray-200 p-8">
        <h1 className="text-2xl font-bold mb-2">Set up your reseller account</h1>
        <p className="text-sm text-gray-700 mb-8">
          Choose a storefront slug and subscribe to the reseller plan ($19/mo) to start selling.
        </p>

        <SetupForm
          currentSlug={profile.slug ?? null}
          hasActiveSub={isActive}
          userId={user.id}
        />
      </div>
    </main>
  );
}
