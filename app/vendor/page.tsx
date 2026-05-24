import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  getVendorApps,
  getVendorStats,
  getVendorMRR,
  getVendorMRRWaterfall,
  getVendorChurnRate,
  getVendorCohortRetention,
  getVendorLTV,
  getVendorChannelMix,
  getVendorBalance,
  getVendorDunning,
  getVendorRefundsDisputes,
  getVendorResellerKickback,
} from "@/lib/services/vendor";
import { getVendorCutBps } from "@/lib/stripe/transfers";
import { KpiCard } from "@/components/ui/KpiCard";
import { EmptyState } from "@/components/ui/EmptyState";
import AppForm from "./_components/AppForm";
import ProfileForm from "./_components/ProfileForm";
import StripeConnect from "./_components/StripeConnect";
import MRRWaterfallChart from "./_components/MRRWaterfallChart";
import CohortRetentionTable from "./_components/CohortRetentionTable";
import AppFilterSelect from "./_components/AppFilterSelect";
import ChannelMixDonut from "./_components/ChannelMixDonut";
import BalanceCard from "./_components/BalanceCard";
import DunningQueueCard from "./_components/DunningQueueCard";
import RefundsFeedCard from "./_components/RefundsFeedCard";
import CommissionTierCard from "./_components/CommissionTierCard";
import ResellerKickbackPanel from "./_components/ResellerKickbackPanel";
import AppsTable from "./_components/AppsTable";

export const metadata: Metadata = { title: "Vendor Dashboard — [PLATFORM]" };

type VendorProfile = {
  role: string;
  display_name: string | null;
  stripe_account_id: string | null;
  charges_enabled: boolean | null;
  payouts_enabled: boolean | null;
  vendor_cut_bps_override: number | null;
  reseller_openness: string | null;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-[10px] border border-border shadow-[var(--shadow-card)] p-5">
      <h2 className="text-[13px] font-semibold text-foreground mb-4">{title}</h2>
      {children}
    </div>
  );
}

export default async function VendorDashboard({
  searchParams,
}: {
  searchParams: Promise<{ app?: string }>;
}) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = (await import("@/lib/services/supabase")).createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: profile } = await (admin as any)
    .from("profiles")
    .select(
      "role, display_name, stripe_account_id, charges_enabled, payouts_enabled, vendor_cut_bps_override, reseller_openness"
    )
    .eq("id", user.id)
    .single() as { data: VendorProfile | null };

  if (profile?.role !== "vendor") redirect("/login");

  const { app: selectedAppId } = await searchParams;
  const appFilter = selectedAppId || undefined;

  // Fetch all data in parallel
  const [
    apps,
    stats,
    mrr,
    waterfall,
    cohort,
    ltv,
    effectiveCutBps,
    channelMix,
    balance,
    dunning,
    refundsFeed,
    kickback,
  ] = await Promise.all([
    getVendorApps(user.id),
    getVendorStats(),
    getVendorMRR(user.id, appFilter),
    getVendorMRRWaterfall(user.id, 6, appFilter),
    getVendorCohortRetention(user.id),
    getVendorLTV(user.id),
    getVendorCutBps(user.id),
    getVendorChannelMix(user.id, appFilter),
    getVendorBalance(user.id),
    getVendorDunning(user.id),
    getVendorRefundsDisputes(user.id),
    getVendorResellerKickback(user.id),
  ]);

  // Trailing churn for KPI delta
  const now = new Date();
  const [c1, c2, c3] = await Promise.all([
    getVendorChurnRate(user.id, now, appFilter),
    getVendorChurnRate(user.id, new Date(now.getFullYear(), now.getMonth() - 1, 1), appFilter),
    getVendorChurnRate(user.id, new Date(now.getFullYear(), now.getMonth() - 2, 1), appFilter),
  ]);
  const trailing3Bps = Math.round((c1 + c2 + c3) / 3);

  // Per-app channel mix for the apps table
  const channelMixByApp = new Map<string, Awaited<ReturnType<typeof getVendorChannelMix>>>();
  await Promise.all(
    apps.map(async (app) => {
      const mix = await getVendorChannelMix(user.id, app.id);
      channelMixByApp.set(app.id, mix);
    })
  );

  // MRR sparkline from waterfall
  const mrrSparkline = waterfall.map((w) => w.end_mrr_cents);
  const prevMonthMrr = waterfall.length >= 2 ? waterfall[waterfall.length - 2].end_mrr_cents : null;
  const mrrDelta =
    prevMonthMrr && prevMonthMrr > 0
      ? ((mrr.mrr_cents - prevMonthMrr) / prevMonthMrr) * 100
      : undefined;

  const churnDelta = trailing3Bps > 0 ? ((c1 - trailing3Bps) / trailing3Bps) * 100 : undefined;

  function formatCents(cents: number) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
    }).format(cents / 100);
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Quick-action bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-[15px] font-semibold text-foreground flex-1">Vendor Dashboard</h1>
        <AppFilterSelect apps={apps} selectedAppId={selectedAppId ?? null} />
        <a
          href="#submit"
          className="text-[13px] px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          + New app
        </a>
      </div>

      {/* ── 1. Hero KPI strip ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Net MRR"
          value={formatCents(mrr.mrr_cents)}
          delta={mrrDelta}
          deltaLabel="vs last mo"
          sparkline={mrrSparkline}
          sub={`${mrr.active_subs} active sub${mrr.active_subs !== 1 ? "s" : ""}`}
        />
        <KpiCard
          label="Active subscribers"
          value={mrr.active_subs}
          sub={`ARPU ${formatCents(mrr.arpu_cents)}`}
        />
        <KpiCard
          label="Monthly churn"
          value={(c1 / 100).toFixed(1) + "%"}
          delta={churnDelta !== undefined ? -churnDelta : undefined}
          deltaLabel="vs 3-mo avg"
          sub={`3-mo avg ${(trailing3Bps / 100).toFixed(1)}%`}
        />
        <KpiCard
          label="LTV / customer"
          value={formatCents(ltv.avg_ltv_cents)}
          sub={ltv.data_sparse ? "Sparse data (<6 mo)" : ltv.method}
        />
      </div>

      {/* ── 2. Revenue mix + 3. Stripe balance (side by side) ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Section title="Revenue mix">
          {channelMix.total_cents === 0 ? (
            <EmptyState
              title="No active subscriptions"
              body="Revenue breakdown will appear once you have subscribers."
              cta={<span className="text-[12px] text-muted-foreground">Submit your first app to get started.</span>}
            />
          ) : (
            <ChannelMixDonut mix={channelMix} />
          )}
        </Section>

        <Section title="Stripe Connect & cash flow">
          <BalanceCard
            balance={balance}
            stripeAccountId={profile.stripe_account_id ?? null}
            chargesEnabled={profile.charges_enabled ?? false}
            payoutsEnabled={profile.payouts_enabled ?? false}
          />
          {profile.stripe_account_id && (
            <div className="mt-3">
              <StripeConnect
                stripeAccountId={profile.stripe_account_id}
                chargesEnabled={profile.charges_enabled ?? false}
                payoutsEnabled={profile.payouts_enabled ?? false}
              />
            </div>
          )}
          {!profile.stripe_account_id && (
            <div className="mt-3">
              <StripeConnect
                stripeAccountId={null}
                chargesEnabled={false}
                payoutsEnabled={false}
              />
            </div>
          )}
        </Section>
      </div>

      {/* ── 4. Dunning queue ─────────────────────────────────────────────── */}
      {dunning.count > 0 && (
        <Section title={`Dunning queue (${dunning.count})`}>
          <DunningQueueCard dunning={dunning} />
        </Section>
      )}

      {/* ── 5. Refunds & disputes ─────────────────────────────────────────── */}
      <Section title="Refunds & disputes (last 30 days)">
        <RefundsFeedCard feed={refundsFeed} />
      </Section>

      {/* ── 6. Commission tier ─────────────────────────────────────────────── */}
      <Section title="Commission & fee breakdown">
        <CommissionTierCard
          effectiveCutBps={effectiveCutBps}
          overrideBps={profile.vendor_cut_bps_override ?? null}
          netMrrCents={mrr.mrr_cents}
        />
      </Section>

      {/* ── 7. Reseller-openness panel ─────────────────────────────────────── */}
      <Section title="Reseller openness">
        <ResellerKickbackPanel
          current={
            (profile.reseller_openness ?? "open_to_resellers") as
              | "closed"
              | "open_to_resellers"
              | "open_to_wl"
          }
          kickback={kickback}
        />
      </Section>

      {/* ── 8. Apps table ─────────────────────────────────────────────────── */}
      <Section title={`My apps (${apps.length})`}>
        <AppsTable apps={apps} stats={stats} channelMixByApp={channelMixByApp} />
      </Section>

      {/* ── 9 & 10. MRR waterfall + cohort retention ───────────────────────── */}
      <Section title="MRR waterfall — last 6 months">
        <MRRWaterfallChart data={waterfall} />
      </Section>

      <Section title="Cohort retention">
        <CohortRetentionTable rows={cohort} />
        <p className="text-[11px] text-muted-foreground mt-3">
          MRR includes direct + affiliate subs. Reseller-sold subs counted at vendor floor.
        </p>
      </Section>

      {/* ── Submit new app ────────────────────────────────────────────────── */}
      <Section title="Submit new app">
        <div id="submit">
          <AppForm />
        </div>
      </Section>

      {/* ── Profile ──────────────────────────────────────────────────────── */}
      <Section title="Profile">
        <ProfileForm currentDisplayName={profile.display_name ?? ""} />
      </Section>
    </div>
  );
}
