import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { DashboardShell } from "@/components/layout/DashboardShell";

const RESELLER_NAV = [
  { label: "Dashboard", href: "/reseller" },
  { label: "Discover", href: "/reseller?tab=discover" },
  { label: "Offers", href: "/reseller/offers" },
  { label: "Brand", href: "/reseller/brand" },
  { label: "Setup", href: "/reseller/setup" },
];

export default async function ResellerLayout({ children }: { children: ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "reseller") redirect("/login");

  return (
    <DashboardShell
      nav={RESELLER_NAV}
      user={{ email: user.email ?? "", role: "reseller" }}
      testMode={process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? false}
    >
      {children}
    </DashboardShell>
  );
}
