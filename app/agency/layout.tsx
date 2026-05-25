import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { OrgSwitcher } from "@/components/layout/OrgSwitcher";
import { getUserOrgs, getActiveOrg } from "@/lib/services/org";
import { NotificationBellConnected } from "@/components/layout/NotificationBellConnected";

const AGENCY_NAV = [
  { label: "Clients",  href: "/agency" },
  { label: "Payouts",  href: "/agency/payouts" },
  { label: "Settings", href: "/settings/organization" },
  { label: "Account",  href: "/settings/account" },
];

export default async function AgencyLayout({ children }: { children: ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Resolve active org and gate on org.type = 'agency'
  const { org, role } = await getActiveOrg();
  if (org.type !== "agency") redirect("/login");

  const orgs = await getUserOrgs(user.id);
  const orgOptions = orgs.map(({ org: o, role: r }) => ({
    id: o.id,
    name: o.name,
    type: o.type as "personal" | "team",
    role: r,
  }));

  return (
    <DashboardShell
      nav={AGENCY_NAV}
      user={{ email: user.email ?? "", role: "agency" }}
      testMode={process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? false}
      notificationBell={<NotificationBellConnected />}
      orgSwitcher={<OrgSwitcher orgs={orgOptions} currentOrgId={org.id} />}
    >
      {children}
    </DashboardShell>
  );
}
