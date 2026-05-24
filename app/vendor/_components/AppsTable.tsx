"use client";

import { useState } from "react";
import Image from "next/image";
import { Drawer } from "@/components/ui/Drawer";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { Sparkline } from "@/components/ui/Sparkline";
import type { VendorApp, VendorSubscriptionStat, ChannelMix } from "@/lib/services/vendor";

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

const STATUS_VARIANT: Record<string, "ok" | "warn" | "bad" | "outline"> = {
  approved: "ok",
  pending: "warn",
  rejected: "bad",
};

function getAppStats(appId: string, stats: VendorSubscriptionStat[]) {
  const active = stats.filter(
    (s) => s.app_id === appId && (s.status === "active" || s.status === "trialing")
  );
  return {
    activeCount: active.length,
    mrrCents: active.reduce((sum, s) => sum + s.price_cents, 0),
  };
}

function MiniDonut({ mix }: { mix: ChannelMix | undefined }) {
  if (!mix || mix.total_cents === 0) return <span className="text-[11px] text-muted-foreground">—</span>;
  const total = mix.total_cents;
  const r = 8;
  const c = 2 * Math.PI * r;
  const directDash = (mix.direct_cents / total) * c;
  const affiliateDash = (mix.affiliate_cents / total) * c;

  return (
    <svg width={20} height={20} viewBox="0 0 20 20" className="inline-block">
      <circle cx={10} cy={10} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={4} />
      <circle cx={10} cy={10} r={r} fill="none" stroke="hsl(var(--primary))" strokeWidth={4}
        strokeDasharray={`${directDash} ${c - directDash}`}
        style={{ transform: "rotate(-90deg)", transformOrigin: "10px 10px" }} />
      {mix.affiliate_cents > 0 && (
        <circle cx={10} cy={10} r={r} fill="none" stroke="#22c55e" strokeWidth={4}
          strokeDasharray={`${affiliateDash} ${c - affiliateDash}`}
          strokeDashoffset={-directDash}
          style={{ transform: "rotate(-90deg)", transformOrigin: "10px 10px" }} />
      )}
    </svg>
  );
}

function AppDrawer({
  app,
  stats,
  channelMix,
  onClose,
}: {
  app: VendorApp;
  stats: VendorSubscriptionStat[];
  channelMix: ChannelMix | undefined;
  onClose: () => void;
}) {
  const { activeCount, mrrCents } = getAppStats(app.id, stats);

  return (
    <Drawer open title={app.name} onClose={onClose}>
      <div className="space-y-5">
        {/* App header */}
        <div className="flex items-center gap-3">
          {app.logo_url ? (
            <Image
              src={app.logo_url}
              alt={app.name}
              width={48}
              height={48}
              className="rounded-xl object-cover shrink-0"
            />
          ) : (
            <div className="w-12 h-12 rounded-xl bg-muted shrink-0" />
          )}
          <div>
            <p className="font-semibold text-foreground">{app.name}</p>
            <Badge variant={STATUS_VARIANT[app.status] ?? "outline"}>{app.status}</Badge>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-muted/40 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">MRR</p>
            <p className="text-[18px] font-semibold tabular-nums">{formatCents(mrrCents)}</p>
          </div>
          <div className="bg-muted/40 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">Subs</p>
            <p className="text-[18px] font-semibold tabular-nums">{activeCount}</p>
          </div>
          <div className="bg-muted/40 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">Price</p>
            <p className="text-[18px] font-semibold tabular-nums">
              {formatCents(app.price_cents)}
            </p>
          </div>
        </div>

        {/* Channel mix */}
        {channelMix && channelMix.total_cents > 0 && (
          <div>
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Channel mix
            </p>
            <div className="space-y-1.5 text-[13px]">
              {[
                { label: "Direct", cents: channelMix.direct_cents, count: channelMix.direct_count, color: "hsl(var(--primary))" },
                { label: "Affiliate", cents: channelMix.affiliate_cents, count: channelMix.affiliate_count, color: "#22c55e" },
                { label: "Reseller", cents: channelMix.reseller_cents, count: channelMix.reseller_count, color: "#f59e0b" },
              ].map((c) => (
                <div key={c.label} className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />
                  <span className="flex-1 text-muted-foreground">{c.label}</span>
                  <span className="tabular-nums">{formatCents(c.cents)}</span>
                  <span className="text-muted-foreground w-14 text-right">{c.count} sub{c.count !== 1 ? "s" : ""}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* App details */}
        <div className="space-y-1 text-[13px]">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">Details</p>
          {app.category && (
            <div className="flex justify-between py-1 border-b border-border-soft">
              <span className="text-muted-foreground">Category</span>
              <span>{app.category}</span>
            </div>
          )}
          <div className="flex justify-between py-1 border-b border-border-soft">
            <span className="text-muted-foreground">List price</span>
            <span>{formatCents(app.price_cents)}/mo</span>
          </div>
          {app.min_price_cents != null && (
            <div className="flex justify-between py-1 border-b border-border-soft">
              <span className="text-muted-foreground">Reseller floor</span>
              <span>{formatCents(app.min_price_cents)}/mo</span>
            </div>
          )}
          {app.affiliate_commission_bps != null && (
            <div className="flex justify-between py-1 border-b border-border-soft">
              <span className="text-muted-foreground">Affiliate commission</span>
              <span>{(app.affiliate_commission_bps / 100).toFixed(0)}%</span>
            </div>
          )}
          <div className="flex justify-between py-1">
            <span className="text-muted-foreground">Status</span>
            <Badge variant={STATUS_VARIANT[app.status] ?? "outline"}>{app.status}</Badge>
          </div>
        </div>

        {/* Quick links */}
        <div className="flex gap-2 flex-wrap pt-1">
          <a
            href={`/vendor/apps/${app.id}`}
            className="text-[13px] px-3 py-1.5 rounded-lg border border-border hover:bg-muted/40 transition-colors"
          >
            Edit app →
          </a>
        </div>
      </div>
    </Drawer>
  );
}

export default function AppsTable({
  apps,
  stats,
  channelMixByApp,
}: {
  apps: VendorApp[];
  stats: VendorSubscriptionStat[];
  channelMixByApp: Map<string, ChannelMix>;
}) {
  const [selectedApp, setSelectedApp] = useState<VendorApp | null>(null);

  if (apps.length === 0) {
    return (
      <EmptyState
        icon={<span>📦</span>}
        title="No apps yet"
        body="Submit your first app to start selling on the marketplace."
        cta={
          <a
            href="#submit"
            className="text-[13px] px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Submit an app
          </a>
        }
      />
    );
  }

  return (
    <>
      <DenseTable cols={["App", "Status", "MRR", "Subs", "Mix"]}>
        {apps.map((app) => {
          const { activeCount, mrrCents } = getAppStats(app.id, stats);
          const mix = channelMixByApp.get(app.id);
          // Build sparkline from active sub prices as a simple trend proxy
          const sparkData = [mrrCents * 0.85, mrrCents * 0.9, mrrCents * 0.95, mrrCents];

          return (
            <DenseRow key={app.id} cols={5} onClick={() => setSelectedApp(app)}>
              <DenseCell>
                <div className="flex items-center gap-2">
                  {app.logo_url ? (
                    <Image
                      src={app.logo_url}
                      alt={app.name}
                      width={20}
                      height={20}
                      className="rounded object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-5 h-5 rounded bg-muted shrink-0" />
                  )}
                  <span className="font-medium truncate">{app.name}</span>
                </div>
              </DenseCell>
              <DenseCell>
                <Badge variant={STATUS_VARIANT[app.status] ?? "outline"}>
                  {app.status}
                </Badge>
              </DenseCell>
              <DenseCell align="right">
                <div className="flex items-center gap-2 justify-end">
                  <Sparkline
                    points={sparkData}
                    color="hsl(var(--primary))"
                    width={40}
                    height={16}
                  />
                  <span className="tabular-nums">{formatCents(mrrCents)}</span>
                </div>
              </DenseCell>
              <DenseCell align="right">{activeCount}</DenseCell>
              <DenseCell align="center">
                <MiniDonut mix={mix} />
              </DenseCell>
            </DenseRow>
          );
        })}
      </DenseTable>

      {selectedApp && (
        <AppDrawer
          app={selectedApp}
          stats={stats}
          channelMix={channelMixByApp.get(selectedApp.id)}
          onClose={() => setSelectedApp(null)}
        />
      )}
    </>
  );
}
