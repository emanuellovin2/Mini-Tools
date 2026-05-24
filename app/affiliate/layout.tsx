import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { DashboardShell } from "@/components/layout/DashboardShell";

const AFFILIATE_NAV = [
  { label: "Dashboard", href: "/affiliate" },
  { label: "Public Profile", href: "/affiliates/top" },
];

export default async function AffiliateLayout({ children }: { children: ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "affiliate") redirect("/login");

  return (
    <DashboardShell
      nav={AFFILIATE_NAV}
      user={{ email: user.email ?? "", role: "affiliate" }}
      testMode={process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? false}
    >
      {children}
    </DashboardShell>
  );
}
