import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  getPlatformStats,
  getPendingApps,
  getVendors,
  getAllSubscriptions,
  getAuditLog,
  getChurnAlerts,
  dispatchChurnAlerts,
  getVendorsWithCutInfo,
  getTakeRateTrend,
  getChannelMix,
  getConcentrationRisk,
  getPayoutObligation,
  getWebhookStats,
  getSystemHealth,
  getFeatureFlags,
} from "@/lib/services/admin";
import { formatPrice } from "@/lib/services/apps";
import { PageHeader } from "@/components/layout/PageHeader";
import { KpiCard } from "@/components/ui/KpiCard";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import ApproveRejectButtons from "./_components/ApproveRejectButtons";
import SyncStripeButton from "./_components/SyncStripeButton";
import VendorCutOverrideTable from "./_components/VendorCutOverride";
import { FeatureFlagsPanel } from "./_components/FeatureFlagsPanel";
import { VendorTable } from "./_components/VendorDrawer";
import { SubLookupTool } from "./_components/SubLookupTool";

export const metadata: Metadata = {
  title: "Admin — [PLATFORM]",
};

type Props = {
  searchParams: Promise<Record<string, string | undefined>>;
};

function cents(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n / 100);
}

function dateShort(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function HealthChip({ label, status, detail }: { label: string; status: "ok" | "warn" | "error"; detail: string }) {
  const cls = status === "ok"
    ? "bg-ok-soft text-ok border-ok/20"
    : status === "warn"
    ? "bg-warn-soft text-warn border-warn/20"
    : "bg-bad-soft text-bad border-bad/20";
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium ${cls}`} title={detail}>
      <span className={`w-1.5 h-1.5 rounded-full ${status === "ok" ? "bg-ok" : status === "warn" ? "bg-warn" : "bg-bad"}`} />
      {label}
      <span className="opacity-70 font-normal">· {detail}</span>
    </div>
  );
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "vendors", label: "Vendors" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "webhooks", label: "Webhooks" },
  { id: "audit", label: "Audit log" },
  { id: "tools", label: "Tools" },
  { id: "settings", label: "Settings" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default async function AdminDashboard({ searchParams }: Props) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") redirect("/login");

  const sp = await searchParams;
  const tab = (sp.tab ?? "overview") as TabId;
  const auditPage = Math.max(1, Number(sp.audit_page ?? 1));
  const auditActorId = sp.actor_id;
  const auditEntityType = sp.entity_type;
  const auditSince = sp.since;
  const auditUntil = sp.until;
  const subPage = Math.max(1, Number(sp.sub_page ?? 1));
  const thresholdBps = Number(process.env.CHURN_ALERT_THRESHOLD_BPS ?? "2000");

  const tabs = TABS.map((t) => ({
    label: t.label,
    href: `/admin?tab=${t.id}`,
    active: t.id === tab,
  }));

  // Fetch only what the active tab needs
  const [
    stats,
    health,
    takeRate,
    channelMix,
    concentration,
    payoutObligation,
    webhookStats,
    pendingApps,
    vendors,
    vendorCutInfo,
    subs,
    auditResult,
    churnAlerts,
    featureFlags,
  ] = await Promise.all([
    tab === "overview" || tab === "vendors" ? getPlatformStats() : Promise.resolve({ gmvCents: 0, mrrCents: 0, cutCents: 0 }),
    tab === "overview" ? getSystemHealth() : Promise.resolve(null),
    tab === "overview" ? getTakeRateTrend(12) : Promise.resolve([]),
    tab === "overview" ? getChannelMix(12) : Promise.resolve([]),
    tab === "overview" ? getConcentrationRisk() : Promise.resolve(null),
    tab === "overview" ? getPayoutObligation() : Promise.resolve(null),
    tab === "webhooks" ? getWebhookStats() : Promise.resolve(null),
    tab === "overview" || tab === "vendors" ? getPendingApps() : Promise.resolve([]),
    tab === "vendors" ? getVendors() : Promise.resolve([]),
    tab === "vendors" ? getVendorsWithCutInfo() : Promise.resolve([]),
    tab === "subscriptions"
      ? getAllSubscriptions({ page: subPage })
      : Promise.resolve({ subscriptions: [], total: 0, totalPages: 0 }),
    tab === "audit"
      ? getAuditLog({ actorId: auditActorId, entityType: auditEntityType, since: auditSince, until: auditUntil, page: auditPage })
      : Promise.resolve({ entries: [], total: 0, totalPages: 0 }),
    tab === "overview" ? getChurnAlerts(thresholdBps) : Promise.resolve([]),
    tab === "settings" ? getFeatureFlags() : Promise.resolve([]),
  ]);

  if (tab === "overview" && churnAlerts.length > 0) {
    dispatchChurnAlerts(churnAlerts).catch(console.error);
  }

  function auditHref(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    const merged = { actor_id: auditActorId, entity_type: auditEntityType, since: auditSince, until: auditUntil, audit_page: "1", tab: "audit", ...overrides };
    for (const [k, v] of Object.entries(merged)) { if (v) p.set(k, v); }
    return `/admin?${p.toString()}`;
  }

  // sparkline data from take-rate trend
  const gmvSparkline = takeRate.slice(-6).map((r) => r.gmv_cents);
  const cutSparkline = takeRate.slice(-6).map((r) => r.cut_cents);

  return (
    <>
      <PageHeader title="Admin" tabs={tabs} />

      {/* ── Overview ─────────────────────────────────────────────────── */}
      {tab === "overview" && (
        <div className="space-y-8 mt-6">
          {/* System health row */}
          {health && (
            <section>
              {health.overall === "error" && (
                <div className="mb-3 px-4 py-2.5 rounded-lg bg-bad-soft border border-bad/20 text-sm text-bad font-medium">
                  System issue detected — check health chips below.
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {health.checks.map((c) => (
                  <HealthChip key={c.label} label={c.label} status={c.status} detail={c.detail} />
                ))}
              </div>
            </section>
          )}

          {/* KPI strip */}
          <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <KpiCard
              label="GMV (all-time)"
              value={cents(stats.gmvCents)}
              sparkline={gmvSparkline}
              sparklineColor="hsl(var(--primary))"
            />
            <KpiCard
              label="Active MRR"
              value={cents(stats.mrrCents)}
            />
            <KpiCard
              label="Platform cut"
              value={cents(stats.cutCents)}
              sparkline={cutSparkline}
              sparklineColor="hsl(var(--ok))"
            />
            <KpiCard
              label="Take rate"
              value={
                takeRate.length > 0 && takeRate[takeRate.length - 1].gmv_cents > 0
                  ? `${(takeRate[takeRate.length - 1].rate_bps / 100).toFixed(1)}%`
                  : "—"
              }
              sub="last billing cycle"
            />
            <KpiCard
              label="Pending apps"
              value={pendingApps.length}
              sub={pendingApps.length > 0 ? "awaiting review" : "queue clear"}
            />
          </section>

          {/* Channel mix + Concentration side-by-side */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Channel mix */}
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Channel mix (new subs)</h2>
              {channelMix.length === 0 ? (
                <p className="text-sm text-muted-foreground">No subscription data yet.</p>
              ) : (
                <div className="space-y-2">
                  {(() => {
                    const last = channelMix[channelMix.length - 1];
                    const total = last.direct + last.affiliate + last.reseller;
                    return [
                      { label: "Direct", value: last.direct, color: "bg-primary" },
                      { label: "Affiliate", value: last.affiliate, color: "bg-ok" },
                      { label: "Reseller", value: last.reseller, color: "bg-warn" },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="flex items-center gap-3">
                        <span className="w-20 text-xs text-muted-foreground shrink-0">{label}</span>
                        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className={`h-full ${color} rounded-full`}
                            style={{ width: total > 0 ? `${(value / total) * 100}%` : "0%" }}
                          />
                        </div>
                        <span className="text-xs font-medium tabular-nums w-6 text-right">{value}</span>
                      </div>
                    ));
                  })()}
                  <p className="text-xs text-muted-foreground mt-1">Latest month · {channelMix[channelMix.length - 1].month}</p>
                </div>
              )}
            </section>

            {/* Concentration risk */}
            {concentration && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                  Concentration risk
                  {concentration.alarm && (
                    <Badge variant="bad">Alert &gt;20%</Badge>
                  )}
                </h2>
                {concentration.top5.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No revenue data yet.</p>
                ) : (
                  <div className="space-y-2">
                    {concentration.top5.map((v) => (
                      <div key={v.vendor_id} className="flex items-center gap-3">
                        <span className="w-28 text-xs text-foreground font-medium truncate shrink-0">
                          {v.vendor_name ?? v.vendor_id.slice(0, 8)}
                        </span>
                        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${v.share_bps > 2000 ? "bg-bad" : "bg-primary"}`}
                            style={{ width: `${v.share_bps / 100}%` }}
                          />
                        </div>
                        <span className="text-xs tabular-nums w-10 text-right text-muted-foreground">
                          {(v.share_bps / 100).toFixed(1)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>

          {/* Payout obligation */}
          {payoutObligation && (
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Payout obligation (active MRR)</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <KpiCard label="To vendors" value={cents(payoutObligation.vendor_mrr_cents)} sub={`${payoutObligation.vendor_count} payees`} />
                <KpiCard label="To affiliates" value={cents(payoutObligation.affiliate_mrr_cents)} sub={`${payoutObligation.affiliate_count} payees`} />
                <KpiCard label="To resellers" value={cents(payoutObligation.reseller_mrr_cents)} sub={`${payoutObligation.reseller_count} payees`} />
                <KpiCard
                  label="Total monthly"
                  value={cents(payoutObligation.total_mrr_cents)}
                  sub="estimate"
                />
              </div>
            </section>
          )}

          {/* Churn alerts */}
          {churnAlerts.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Churn alerts — threshold {(thresholdBps / 100).toFixed(0)}%
              </h2>
              <div className="overflow-hidden rounded-[10px] border border-bad/30 bg-bad-soft/20">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-bad-soft/40 text-left">
                      {["Vendor", "Rate", "Canceled", "Active at start", "Alert"].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-xs font-semibold text-bad uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {churnAlerts.map((a) => (
                      <tr key={a.vendor_id} className="border-t border-bad/10">
                        <td className="px-4 py-2 text-foreground font-medium">{a.vendor_name ?? a.vendor_id.slice(0, 8)}</td>
                        <td className="px-4 py-2 text-bad font-semibold">{(a.rate_bps / 100).toFixed(1)}%</td>
                        <td className="px-4 py-2">{a.canceled}</td>
                        <td className="px-4 py-2">{a.active_at_start}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{a.already_alerted ? "Sent" : "Sending…"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Pending app queue */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Pending apps ({pendingApps.length})
              </h2>
              <Link href="/admin/reconciliation" className="text-xs text-primary hover:underline">
                View reconciliation →
              </Link>
            </div>
            {pendingApps.length === 0 ? (
              <EmptyState title="Queue clear" body="No apps awaiting review." />
            ) : (
              <div className="overflow-hidden rounded-[10px] border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/40 text-left">
                      {["App", "Vendor", "Price", "Submitted", "SLA", "Actions"].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pendingApps.map((app) => {
                      const submittedMs = new Date(app.created_at).getTime();
                      const slaHours = Math.max(0, 24 - Math.floor((Date.now() - submittedMs) / 3600_000));
                      return (
                        <tr key={app.id} className="border-t border-border">
                          <td className="px-4 py-3">
                            <p className="font-medium text-foreground">{app.name}</p>
                            {app.description && <p className="text-xs text-muted-foreground truncate max-w-[200px]">{app.description}</p>}
                          </td>
                          <td className="px-4 py-3">
                            <p>{app.vendor_name ?? "—"}</p>
                            {!app.vendor_charges_enabled && <p className="text-xs text-bad">Stripe not connected</p>}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{app.formatted_price}/mo</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{dateShort(app.created_at)}</td>
                          <td className="px-4 py-3">
                            <Badge variant={slaHours < 2 ? "bad" : slaHours < 8 ? "warn" : "secondary"}>
                              {slaHours}h left
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            <ApproveRejectButtons appId={app.id} chargesEnabled={app.vendor_charges_enabled} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── Vendors ──────────────────────────────────────────────────── */}
      {tab === "vendors" && (
        <div className="space-y-8 mt-6">
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Vendors ({vendors.length})
            </h2>
            <VendorTable vendors={vendors} />
          </section>

          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Commission overrides
            </h2>
            <VendorCutOverrideTable vendors={vendorCutInfo} />
          </section>
        </div>
      )}

      {/* ── Subscriptions ────────────────────────────────────────────── */}
      {tab === "subscriptions" && (
        <div className="space-y-4 mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            All subscriptions ({subs.total})
          </h2>
          <div className="overflow-hidden rounded-[10px] border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left">
                  {["App", "Buyer", "Status", "Price", "Channel", "Period end", "Created"].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {subs.subscriptions.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">No subscriptions.</td></tr>
                ) : (
                  subs.subscriptions.map((s) => (
                    <tr key={s.id} className="border-t border-border hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3 font-medium text-foreground">{s.app_name}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground font-mono">{s.buyer_id.slice(0, 8)}…</td>
                      <td className="px-4 py-3">
                        <Badge variant={s.status === "active" || s.status === "trialing" ? "ok" : s.status === "past_due" ? "bad" : "secondary"}>
                          {s.status}
                        </Badge>
                        {s.cancel_at_period_end && <span className="ml-1 text-xs text-warn">(cancels)</span>}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{s.formatted_price}/mo</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">Direct</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{dateShort(s.current_period_end)}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{dateShort(s.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {subs.totalPages > 1 && (
            <div className="flex items-center gap-3 text-sm">
              {subPage > 1 && (
                <Link href={`/admin?tab=subscriptions&sub_page=${subPage - 1}`}>
                  <Button variant="outline" size="sm">← Prev</Button>
                </Link>
              )}
              <span className="text-muted-foreground">{subPage} / {subs.totalPages}</span>
              {subPage < subs.totalPages && (
                <Link href={`/admin?tab=subscriptions&sub_page=${subPage + 1}`}>
                  <Button variant="outline" size="sm">Next →</Button>
                </Link>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Webhooks ─────────────────────────────────────────────────── */}
      {tab === "webhooks" && webhookStats && (
        <div className="space-y-6 mt-6">
          {/* Stats strip */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <KpiCard label="Received (1h)" value={webhookStats.received_1h} />
            <KpiCard label="Processed (1h)" value={webhookStats.processed_1h} />
            <KpiCard
              label="Failed (1h)"
              value={webhookStats.failed_1h}
              sparklineColor="hsl(var(--bad))"
            />
            <KpiCard label="Received (24h)" value={webhookStats.received_24h} />
            <KpiCard
              label="Lag"
              value={
                webhookStats.lag_seconds == null
                  ? "—"
                  : webhookStats.lag_seconds < 60
                  ? `${webhookStats.lag_seconds}s`
                  : webhookStats.lag_seconds < 3600
                  ? `${Math.floor(webhookStats.lag_seconds / 60)}m`
                  : `${Math.floor(webhookStats.lag_seconds / 3600)}h`
              }
              sub={webhookStats.lag_seconds != null && webhookStats.lag_seconds > 300 ? "⚠ high lag" : "since last event"}
            />
          </div>

          {/* DLQ */}
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Failed events ({webhookStats.dlq.length})
            </h2>
            {webhookStats.dlq.length === 0 ? (
              <EmptyState title="No failed events" body="The dead-letter queue is empty." />
            ) : (
              <div className="overflow-hidden rounded-[10px] border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/40 text-left">
                      {["Event ID", "Type", "Received", "Error"].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {webhookStats.dlq.map((e) => (
                      <tr key={e.id} className="border-t border-border">
                        <td className="px-4 py-2 text-xs font-mono text-muted-foreground">{e.id.slice(0, 14)}…</td>
                        <td className="px-4 py-2 text-xs font-mono text-foreground">{e.type}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{new Date(e.received_at).toLocaleString()}</td>
                        <td className="px-4 py-2 text-xs text-bad truncate max-w-[300px]">{e.error ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── Audit log ────────────────────────────────────────────────── */}
      {tab === "audit" && (
        <div className="space-y-4 mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Audit log ({auditResult.total})
            </h2>
            <a
              href={`/api/admin/audit-export?actor_id=${auditActorId ?? ""}&entity_type=${auditEntityType ?? ""}&since=${auditSince ?? ""}&until=${auditUntil ?? ""}`}
              className="text-xs text-primary hover:underline"
            >
              Export CSV →
            </a>
          </div>

          <form method="get" action="/admin" className="flex flex-wrap gap-2">
            <input type="hidden" name="tab" value="audit" />
            <input name="actor_id" defaultValue={auditActorId} placeholder="Actor ID (uuid)"
              className="border border-border rounded-lg px-3 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30 w-64" />
            <input name="entity_type" defaultValue={auditEntityType} placeholder="Entity type"
              className="border border-border rounded-lg px-3 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30 w-36" />
            <input name="since" type="date" defaultValue={auditSince}
              className="border border-border rounded-lg px-3 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30" />
            <input name="until" type="date" defaultValue={auditUntil}
              className="border border-border rounded-lg px-3 py-1.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30" />
            <Button type="submit" size="sm">Filter</Button>
            {(auditActorId || auditEntityType || auditSince || auditUntil) && (
              <Link href="/admin?tab=audit"><Button variant="outline" size="sm">Clear</Button></Link>
            )}
          </form>

          <div className="overflow-hidden rounded-[10px] border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left">
                  {["When", "Actor", "Action", "Entity", "Entity ID"].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {auditResult.entries.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">No entries match your filters.</td></tr>
                ) : (
                  auditResult.entries.map((e) => (
                    <tr key={e.id} className="border-t border-border">
                      <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                      <td className="px-4 py-2 text-xs">
                        <span className="font-medium text-foreground">{e.actor_role ?? "system"}</span>
                        {e.actor_id && <span className="text-muted-foreground ml-1 font-mono">({e.actor_id.slice(0, 8)}…)</span>}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-foreground">{e.action}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{e.entity_type}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground font-mono">
                        {e.entity_id ? (e.entity_id.length > 20 ? e.entity_id.slice(0, 12) + "…" : e.entity_id) : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {auditResult.totalPages > 1 && (
            <div className="flex items-center gap-3 text-sm">
              {auditPage > 1 && (
                <Link href={auditHref({ audit_page: String(auditPage - 1) })}>
                  <Button variant="outline" size="sm">← Prev</Button>
                </Link>
              )}
              <span className="text-muted-foreground">{auditPage} / {auditResult.totalPages}</span>
              {auditPage < auditResult.totalPages && (
                <Link href={auditHref({ audit_page: String(auditPage + 1) })}>
                  <Button variant="outline" size="sm">Next →</Button>
                </Link>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Tools ────────────────────────────────────────────────────── */}
      {tab === "tools" && (
        <div className="space-y-8 mt-6 max-w-2xl">
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Subscription lookup</h2>
            <p className="text-xs text-muted-foreground mb-4">Look up any subscription by ID to view its state and log a refund request.</p>
            <SubLookupTool />
          </section>

          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Vendor sync</h2>
            <p className="text-xs text-muted-foreground mb-2">
              To sync a vendor's Stripe Connect status, go to the{" "}
              <Link href="/admin?tab=vendors" className="text-primary hover:underline">Vendors tab</Link> and use the Sync button next to the vendor.
            </p>
          </section>
        </div>
      )}

      {/* ── Settings ─────────────────────────────────────────────────── */}
      {tab === "settings" && (
        <div className="space-y-8 mt-6 max-w-xl">
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Feature flags</h2>
            <p className="text-xs text-muted-foreground mb-4">Kill switches for incident response. Changes take effect within 60s (ISR cache TTL).</p>
            <FeatureFlagsPanel flags={featureFlags} />
          </section>

          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">JWT key info</h2>
            <div className="border border-border rounded-[10px] p-4 space-y-2 bg-surface">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Key ID</span>
                <code className="text-sm font-mono text-foreground">{process.env.JWT_KEY_ID ?? "—"}</code>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">JWKS endpoint</span>
                <code className="text-sm font-mono text-foreground">/.well-known/jwks.json</code>
              </div>
              <p className="text-xs text-muted-foreground pt-1">
                To rotate: generate a new RS256 key pair, add the new key to JWKS (keep old key for 30d), then update <code>JWT_KEY_ID</code> env var.
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Churn alert threshold</h2>
            <div className="border border-border rounded-[10px] p-4 bg-surface">
              <p className="text-sm text-foreground font-medium">{(thresholdBps / 100).toFixed(0)}%</p>
              <p className="text-xs text-muted-foreground mt-1">
                Set via <code>CHURN_ALERT_THRESHOLD_BPS</code> env var (currently {thresholdBps} bps).
              </p>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
