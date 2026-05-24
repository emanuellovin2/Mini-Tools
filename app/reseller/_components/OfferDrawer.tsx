"use client";

import { useState, useTransition } from "react";
import { Drawer } from "@/components/ui/Drawer";
import type { OfferAnalytics, MarkupSimResult } from "@/lib/services/reseller";
import MarkupSimulator from "./MarkupSimulator";

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function FunnelBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const w = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-right text-[12px] text-muted-foreground">{label}</span>
      <div className="flex-1 h-5 bg-muted/40 rounded overflow-hidden relative">
        <div className="h-full rounded" style={{ width: `${w}%`, background: color }} />
        <span className="absolute inset-0 flex items-center px-2 text-[12px] font-semibold text-foreground">{value}</span>
      </div>
      <span className="w-10 text-right text-[11px] text-muted-foreground">
        {total > 0 ? ((value / total) * 100).toFixed(0) + "%" : "—"}
      </span>
    </div>
  );
}

export type OfferCardData = {
  id: string;
  slug: string;
  app_name: string;
  sell_price_cents: number;
  vendor_floor_snapshot_cents: number;
  status: string;
  wl_tier: number;
  wl_status: string | null;
  wl_trial_end: string | null;
  wl_display_name: string | null;
  wl_logo_url: string | null;
  wl_brand_color: string | null;
  vendor_openness: "open_to_resellers" | "open_to_wl";
};

export default function OfferDrawer({
  offer,
  analytics,
  appUrl,
  resellerSlug,
  onSimulate,
  onClose,
}: {
  offer: OfferCardData;
  analytics: OfferAnalytics;
  appUrl: string;
  resellerSlug: string;
  onSimulate: (offerId: string, priceCents: number) => Promise<MarkupSimResult>;
  onClose: () => void;
}) {
  const storefrontUrl = `${appUrl}/r/${resellerSlug}/${offer.slug}`;
  const wlUrl = offer.wl_tier === 2 ? `${appUrl}/_wl/${resellerSlug}/${offer.slug}` : null;

  const trialDaysLeft = offer.wl_trial_end
    ? Math.max(0, Math.ceil((new Date(offer.wl_trial_end).getTime() - Date.now()) / 86_400_000))
    : null;

  const [copied, setCopied] = useState(false);
  function copyUrl(url: string) {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Drawer open onClose={onClose} title={`${offer.app_name} — /${offer.slug}`}>
      <div className="space-y-6 pb-8">
        {/* Hero */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[22px] font-semibold tabular-nums">{fmt(offer.sell_price_cents)}/mo</p>
            <p className="text-[12px] text-muted-foreground">
              Floor {fmt(offer.vendor_floor_snapshot_cents)} · Margin{" "}
              {fmt(offer.sell_price_cents - offer.vendor_floor_snapshot_cents)}
            </p>
          </div>
          <span
            className={`text-[12px] px-3 py-1 rounded-full font-medium ${
              offer.status === "active"
                ? "bg-ok-soft text-ok"
                : offer.status === "paused"
                ? "bg-warn-soft text-warn"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {offer.status}
          </span>
        </div>

        {/* Buyer funnel */}
        <div>
          <h3 className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Buyer funnel
          </h3>
          <div className="space-y-2">
            <FunnelBar label="Total" value={analytics.total_subs} total={analytics.total_subs} color="hsl(var(--primary))" />
            <FunnelBar label="Active" value={analytics.active_subs} total={analytics.total_subs} color="#22c55e" />
            <FunnelBar label="Paused" value={analytics.paused_subs} total={analytics.total_subs} color="#f59e0b" />
            <FunnelBar label="Churned" value={analytics.churned_subs} total={analytics.total_subs} color="#ef4444" />
          </div>
        </div>

        {/* Cohort summary */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-muted/30 rounded-lg p-3 text-center">
            <p className="text-[20px] font-semibold tabular-nums">{fmt(analytics.mrr_cents)}</p>
            <p className="text-[11px] text-muted-foreground">MRR</p>
          </div>
          <div className="bg-muted/30 rounded-lg p-3 text-center">
            <p className="text-[20px] font-semibold tabular-nums">{analytics.churn_rate_pct}%</p>
            <p className="text-[11px] text-muted-foreground">Churn rate</p>
          </div>
          <div className="bg-muted/30 rounded-lg p-3 text-center">
            <p className="text-[20px] font-semibold tabular-nums">{analytics.refund_count}</p>
            <p className="text-[11px] text-muted-foreground">Refunds</p>
          </div>
        </div>

        {analytics.refund_count > 0 && (
          <p className="text-[12px] text-bad bg-bad-soft rounded-lg px-3 py-2">
            {analytics.refund_count} refund{analytics.refund_count !== 1 ? "s" : ""} totalling{" "}
            {fmt(analytics.refund_amount_cents)} reversed from your share.
          </p>
        )}

        {/* Storefront URLs */}
        <div>
          <h3 className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Storefront URL
          </h3>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] bg-muted/40 rounded px-2 py-1.5 truncate">
              {storefrontUrl}
            </code>
            <button
              onClick={() => copyUrl(storefrontUrl)}
              className="text-[12px] px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted/40 transition-colors shrink-0"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>

        {/* WL Tier 2 panel */}
        {offer.wl_tier === 2 && wlUrl && (
          <div className="border border-primary/20 rounded-[10px] p-4 space-y-3 bg-primary/5">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-foreground">WL Tier 2</h3>
              {offer.wl_status && (
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                  offer.wl_status === "active"
                    ? "bg-ok-soft text-ok"
                    : offer.wl_status === "trialing"
                    ? "bg-primary/10 text-primary"
                    : "bg-warn-soft text-warn"
                }`}>
                  {offer.wl_status}
                </span>
              )}
            </div>
            {offer.wl_display_name && (
              <div className="flex items-center gap-2">
                {offer.wl_logo_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={offer.wl_logo_url} alt="" className="w-6 h-6 rounded object-contain" />
                )}
                {offer.wl_brand_color && (
                  <span
                    className="w-4 h-4 rounded-full border border-border"
                    style={{ backgroundColor: offer.wl_brand_color }}
                  />
                )}
                <span className="text-[12px] font-medium">{offer.wl_display_name}</span>
              </div>
            )}
            {trialDaysLeft !== null && trialDaysLeft > 0 && (
              <p className="text-[12px] text-primary">
                Trial ends in <strong>{trialDaysLeft} day{trialDaysLeft !== 1 ? "s" : ""}</strong>
              </p>
            )}
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[11px] bg-white/60 rounded px-2 py-1.5 truncate">
                {wlUrl}
              </code>
              <button
                onClick={() => copyUrl(wlUrl)}
                className="text-[12px] px-2.5 py-1.5 rounded-lg border border-primary/30 hover:bg-primary/10 transition-colors shrink-0"
              >
                Copy
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              DNS check ✓ &nbsp;· &nbsp;Subdomain resolves via platform proxy.
            </p>
          </div>
        )}

        {/* WL upgrade CTA if vendor is open_to_wl and offer is Tier 1 */}
        {offer.wl_tier !== 2 && offer.vendor_openness === "open_to_wl" && (
          <div className="bg-muted/30 rounded-[10px] p-4">
            <p className="text-[13px] font-medium mb-1">Upgrade to WL Tier 2</p>
            <p className="text-[12px] text-muted-foreground mb-3">
              Get a branded subdomain storefront for $29/mo. Vendor accepts WL.
            </p>
            <a
              href={`/reseller/offers?upgrade=${offer.id}`}
              className="text-[12px] px-3 py-2 rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors font-medium"
            >
              Upgrade this offer
            </a>
          </div>
        )}

        {/* Markup simulator */}
        <div>
          <h3 className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Markup simulator
          </h3>
          <MarkupSimulator
            offerId={offer.id}
            floorCents={offer.vendor_floor_snapshot_cents}
            currentPriceCents={offer.sell_price_cents}
            onSimulate={onSimulate}
          />
        </div>
      </div>
    </Drawer>
  );
}
