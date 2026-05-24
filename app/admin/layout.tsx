import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { OrgSwitcher } from "@/components/layout/OrgSwitcher";
import { getUserOrgs, getActiveOrg } from "@/lib/services/org";

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

  const [orgs, activeCtx] = await Promise.all([
    getUserOrgs(user.id),
    getActiveOrg(),
  ]);

  const orgOptions = orgs.map(({ org, role }) => ({
    id: org.id, name: org.name, type: org.type as "personal" | "team", role,
  }));

  return (
    <DashboardShell
      nav={ADMIN_NAV}
      user={{ email: user.email ?? "", role: "admin" }}
      testMode={process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? false}
      orgSwitcher={<OrgSwitcher orgs={orgOptions} currentOrgId={activeCtx.org.id} />}
    >
      {children}
    </DashboardShell>
  );
}
