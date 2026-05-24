import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { DashboardShell } from "@/components/layout/DashboardShell";

const ADMIN_NAV = [
  { label: "Overview", href: "/admin" },
  { label: "Reconciliation", href: "/admin/reconciliation" },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") redirect("/login");

  return (
    <DashboardShell
      nav={ADMIN_NAV}
      user={{ email: user.email ?? "", role: "admin" }}
      testMode={process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? false}
    >
      {children}
    </DashboardShell>
  );
}
