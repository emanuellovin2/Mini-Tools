import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { DashboardShell } from "@/components/layout/DashboardShell";

const VENDOR_NAV = [
  { label: "Dashboard", href: "/vendor" },
  { label: "Offers", href: "/reseller/offers" },
  { label: "Brand", href: "/reseller/brand" },
];

export default async function VendorLayout({ children }: { children: ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, display_name")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "vendor") redirect("/login");

  return (
    <DashboardShell
      nav={VENDOR_NAV}
      user={{ email: user.email ?? "", role: "vendor" }}
      testMode={process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? false}
    >
      {children}
    </DashboardShell>
  );
}
