import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { OrgSwitcher } from "@/components/layout/OrgSwitcher";
import { getUserOrgs, getActiveOrg } from "@/lib/services/org";

const SETTINGS_NAV = [
  { label: "Account",       href: "/settings/account" },
  { label: "Notifications", href: "/settings/notifications" },
  { label: "Organization",  href: "/settings/organization" },
  { label: "Activity",      href: "/settings/organization/activity" },
  { label: "API Keys",      href: "/settings/api" },
  { label: "Connections",   href: "/settings/connections" },
];

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [orgs, activeCtx] = await Promise.all([
    getUserOrgs(user.id),
    getActiveOrg(),
  ]);

  const orgOptions = orgs.map(({ org, role }) => ({
    id: org.id,
    name: org.name,
    type: org.type as "personal" | "team",
    role,
  }));

  return (
    <DashboardShell
      nav={SETTINGS_NAV}
      user={{ email: user.email ?? "", role: "settings" }}
      orgSwitcher={
        <OrgSwitcher orgs={orgOptions} currentOrgId={activeCtx.org.id} />
      }
    >
      {children}
    </DashboardShell>
  );
}
