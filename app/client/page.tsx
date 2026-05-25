import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import { getClientPortalSummary, getClientAgencyBranding } from "@/lib/services/client-portal";
import { PageHeader } from "@/components/layout/PageHeader";
import { OutcomeCharts } from "./_components/OutcomeCharts";
import { CreditWallet } from "./_components/CreditWallet";
import { ClientPrivacyPanel } from "./_components/ClientPrivacyPanel";

export const metadata: Metadata = { title: "Client Portal — [PLATFORM]" };

export default async function ClientDashboard() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { org } = await getActiveOrg();
  if (org.type !== "client") redirect("/login");

  const [summary, branding] = await Promise.all([
    getClientPortalSummary(org.id, user.id),
    getClientAgencyBranding(org.id),
  ]);

  return (
    <div className="p-6 space-y-6 max-w-[960px] mx-auto">
      <PageHeader
        title={org.name}
        description={
          branding
            ? `Managed by ${branding.displayName}`
            : "Client portal"
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-border p-4 bg-surface">
          <p className="text-xs text-muted-foreground">Active deployments</p>
          <p className="text-2xl font-bold mt-1">{summary.deploymentCount}</p>
        </div>
        <div className="rounded-xl border border-border p-4 bg-surface">
          <p className="text-xs text-muted-foreground">Credit balance</p>
          <p className="text-2xl font-bold mt-1">
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
              minimumFractionDigits: 2,
            }).format(summary.walletBalance.balanceCents / 100)}
          </p>
        </div>
        <div className="rounded-xl border border-border p-4 bg-surface">
          <p className="text-xs text-muted-foreground">Metrics tracked</p>
          <p className="text-2xl font-bold mt-1">{summary.outcomeSummary.length}</p>
        </div>
      </div>

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <OutcomeCharts rows={summary.outcomeSummary} />
        </div>
        <div className="space-y-6">
          <CreditWallet balanceCents={summary.walletBalance.balanceCents} />
          <ClientPrivacyPanel agencyName={branding?.displayName ?? null} />
        </div>
      </div>
    </div>
  );
}
