import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getActiveOrg } from "@/lib/services/org";
import {
  getAgencyHealthBoard,
  getAgencyBalance,
  getAgencyPayouts,
  listAgencyClients,
  triggerHealthScoreRefresh,
} from "@/lib/services/agency";
import { KpiCard } from "@/components/ui/KpiCard";
import ClientHealthBoard from "./_components/ClientHealthBoard";
import AgencyBalanceCard from "./_components/AgencyBalanceCard";

export const metadata: Metadata = { title: "Agency Dashboard — [PLATFORM]" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-[10px] border border-border shadow-[var(--shadow-card)] p-5">
      <h2 className="text-[13px] font-semibold text-foreground mb-4">{title}</h2>
      {children}
    </div>
  );
}

export default async function AgencyDashboard() {
  const { org } = await getActiveOrg();
  if (org.type !== "agency") redirect("/login");

  // Refresh scores on every page load (cheap RPC; hourly cron covers idle periods).
  // Fire-and-forget — don't block the render.
  void triggerHealthScoreRefresh(org.id).catch(() => null);

  const [board, balance, payouts, clients] = await Promise.all([
    getAgencyHealthBoard(org.id, 25),
    getAgencyBalance(org.id),
    getAgencyPayouts(org.id, 5),
    listAgencyClients(org.id),
  ]);

  const totalClients = clients.length;
  const activeClients = clients.filter(
    (c) => c.relationship.status === "active"
  ).length;
  const highRisk = board.items.filter((s) => s.churn_risk === "high").length;
  const totalDeployments = board.items.reduce(
    (sum, s) => sum + s.active_deployments,
    0
  );

  return (
    <div className="p-6 space-y-6 max-w-[1200px] mx-auto">
      <div>
        <h1 className="text-[17px] font-semibold text-foreground">{org.name}</h1>
        <p className="text-[13px] text-muted-foreground mt-0.5">Agency dashboard</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Total clients" value={totalClients} sub={`${activeClients} active`} />
        <KpiCard label="Active deployments" value={totalDeployments} />
        <KpiCard
          label="High-risk clients"
          value={highRisk}
          sub={highRisk > 0 ? "need attention" : "all healthy"}
        />
        <KpiCard
          label="Stripe available"
          value={
            balance.connected
              ? new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: balance.currency.toUpperCase(),
                  minimumFractionDigits: 0,
                }).format(balance.available_cents / 100)
              : "—"
          }
          sub={balance.connected ? "connect balance" : "not connected"}
        />
      </div>

      {/* Health board + Stripe side-by-side on wide screens */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
        <Section title="Client health board">
          <ClientHealthBoard
            initialItems={board.items}
            initialCursor={board.next_cursor}
          />
        </Section>

        <AgencyBalanceCard balance={balance} payouts={payouts} />
      </div>
    </div>
  );
}
