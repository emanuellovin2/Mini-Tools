import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { OrgSwitcher } from "@/components/layout/OrgSwitcher";
import { getUserOrgs, getActiveOrg } from "@/lib/services/org";
import { NotificationBellConnected } from "@/components/layout/NotificationBellConnected";

const AFFILIATE_NAV = [
  { label: "Dashboard", href: "/affiliate" },
  { label: "Public Profile", href: "/affiliates/top" },
  { label: "Settings", href: "/settings/organization" },
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

  const [orgs, activeCtx] = await Promise.all([
    getUserOrgs(user.id),
    getActiveOrg(),
  ]);

  const orgOptions = orgs.map(({ org, role }) => ({
    id: org.id, name: org.name, type: org.type as "personal" | "team", role,
  }));

  return (
    <DashboardShell
      nav={AFFILIATE_NAV}
      user={{ email: user.email ?? "", role: "affiliate" }}
      testMode={process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? false}
      notificationBell={<NotificationBellConnected />}
      orgSwitcher={<OrgSwitcher orgs={orgOptions} currentOrgId={activeCtx.org.id} />}
    >
      {children}
    </DashboardShell>
  );
}
