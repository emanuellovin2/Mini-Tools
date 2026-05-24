"use client";

import { useState } from "react";
import type { OfferAnalytics, MarkupSimResult } from "@/lib/services/reseller";
import OfferDrawer, { type OfferCardData } from "./OfferDrawer";

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function OfferCard({
  offer,
  analytics,
  onClick,
}: {
  offer: OfferCardData;
  analytics: OfferAnalytics;
  onClick: () => void;
}) {
  const margin = offer.sell_price_cents - offer.vendor_floor_snapshot_cents;

  return (
    <button
      onClick={onClick}
      className="text-left bg-surface rounded-[10px] border border-border shadow-[var(--shadow-card)] p-4 hover:border-primary/40 hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground truncate">{offer.app_name}</p>
          <p className="text-[11px] text-muted-foreground font-mono">/{offer.slug}</p>
        </div>
        <span
          className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full font-medium ${
            offer.status === "active"
              ? "bg-ok-soft text-ok"
              : offer.status === "paused"
              ? "bg-warn-soft text-warn"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {offer.status}
          {offer.wl_tier === 2 && " · WL"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
        <div>
          <p className="text-muted-foreground">Price</p>
          <p className="font-semibold tabular-nums">{fmt(offer.sell_price_cents)}/mo</p>
        </div>
        <div>
          <p className="text-muted-foreground">Your margin</p>
          <p className="font-semibold tabular-nums text-ok">{fmt(margin)}/sale</p>
        </div>
        <div>
          <p className="text-muted-foreground">MRR</p>
          <p className="font-semibold tabular-nums">{fmt(analytics.mrr_cents)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Active buyers</p>
          <p className="font-semibold tabular-nums">{analytics.active_subs}</p>
        </div>
      </div>

      {(analytics.churn_rate_pct > 0 || analytics.total_subs > 0) && (
        <div className="mt-3 pt-3 border-t border-border/50 flex items-center gap-4 text-[11px] text-muted-foreground">
          <span>Churn {analytics.churn_rate_pct.toFixed(1)}%</span>
          {analytics.refund_count > 0 && (
            <span className="text-bad">{analytics.refund_count} refund{analytics.refund_count !== 1 ? "s" : ""}</span>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] text-primary">View analytics →</p>
    </button>
  );
}

export default function OffersGridV2({
  offers,
  analyticsMap,
  appUrl,
  resellerSlug,
  onSimulate,
}: {
  offers: OfferCardData[];
  analyticsMap: Record<string, OfferAnalytics>;
  appUrl: string;
  resellerSlug: string;
  onSimulate: (offerId: string, priceCents: number) => Promise<MarkupSimResult>;
}) {
  const [activeOffer, setActiveOffer] = useState<OfferCardData | null>(null);

  if (offers.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-[13px] text-muted-foreground">No offers yet.</p>
        <a
          href="/reseller?tab=discover"
          className="mt-2 inline-block text-[13px] text-primary hover:underline"
        >
          Browse resellable apps →
        </a>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {offers.map((o) => (
          <OfferCard
            key={o.id}
            offer={o}
            analytics={analyticsMap[o.id] ?? {
              offer_id: o.id,
              total_subs: 0,
              active_subs: 0,
              churned_subs: 0,
              paused_subs: 0,
              mrr_cents: 0,
              churn_rate_pct: 0,
              refund_count: 0,
              refund_amount_cents: 0,
            }}
            onClick={() => setActiveOffer(o)}
          />
        ))}
      </div>

      {activeOffer && (
        <OfferDrawer
          offer={activeOffer}
          analytics={analyticsMap[activeOffer.id] ?? {
            offer_id: activeOffer.id,
            total_subs: 0,
            active_subs: 0,
            churned_subs: 0,
            paused_subs: 0,
            mrr_cents: 0,
            churn_rate_pct: 0,
            refund_count: 0,
            refund_amount_cents: 0,
          }}
          appUrl={appUrl}
          resellerSlug={resellerSlug}
          onSimulate={onSimulate}
          onClose={() => setActiveOffer(null)}
        />
      )}
    </>
  );
}
