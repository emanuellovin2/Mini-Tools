"use client";

import { useState } from "react";
import type { ResellableAppCatalogItem } from "@/lib/services/reseller";

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(cents / 100);
}

function OpennessBadge({ openness }: { openness: "open_to_resellers" | "open_to_wl" }) {
  if (openness === "open_to_wl") {
    return (
      <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 font-medium">
        Tier 1 + WL Tier 2
      </span>
    );
  }
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border font-medium">
      Tier 1
    </span>
  );
}

function AppCard({
  app,
  platformUrl,
}: {
  app: ResellableAppCatalogItem;
  platformUrl: string;
}) {
  const suggestedLow = Math.ceil((app.min_price_cents * 1.15) / 100) * 100;
  const suggestedHigh = Math.ceil((app.min_price_cents * 1.4) / 100) * 100;
  const earningLow = suggestedLow - app.min_price_cents;
  const earningHigh = suggestedHigh - app.min_price_cents;
  const hero = app.screenshot_urls[0] ?? null;

  return (
    <div className="bg-surface rounded-[10px] border border-border shadow-[var(--shadow-card)] overflow-hidden flex flex-col">
      {hero ? (
        <div className="h-32 bg-muted overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={hero} alt="" className="w-full h-full object-cover" />
        </div>
      ) : (
        <div className="h-32 bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
          {app.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={app.logo_url} alt="" className="w-12 h-12 object-contain rounded-lg" />
          ) : (
            <span className="text-2xl opacity-30">📦</span>
          )}
        </div>
      )}

      <div className="p-4 flex flex-col gap-2 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">{app.name}</p>
            <p className="text-[11px] text-muted-foreground truncate">{app.vendor_display_name}</p>
          </div>
          <OpennessBadge openness={app.reseller_openness} />
        </div>

        {app.description && (
          <p className="text-[12px] text-muted-foreground line-clamp-2">{app.description}</p>
        )}

        <div className="text-[12px] space-y-0.5 mt-auto pt-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Vendor floor</span>
            <span className="font-medium tabular-nums">{fmt(app.min_price_cents)}/mo</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Suggested range</span>
            <span className="font-medium tabular-nums">
              {fmt(suggestedLow)}–{fmt(suggestedHigh)}/mo
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Projected earnings</span>
            <span className="font-medium tabular-nums text-ok">
              {fmt(earningLow)}–{fmt(earningHigh)}/sale
            </span>
          </div>
        </div>

        {app.has_offer ? (
          <a
            href="/reseller/offers"
            className="mt-2 text-center text-[12px] px-3 py-2 rounded-lg border border-primary/30 text-primary hover:bg-primary/5 transition-colors"
          >
            View existing offer →
          </a>
        ) : (
          <a
            href={`/reseller/offers?create=1&app_id=${app.id}&app_name=${encodeURIComponent(app.name)}`}
            className="mt-2 text-center text-[12px] px-3 py-2 rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors font-medium"
          >
            Create offer
          </a>
        )}
      </div>
    </div>
  );
}

export default function DiscoverSection({
  apps,
  platformUrl,
}: {
  apps: ResellableAppCatalogItem[];
  platformUrl: string;
}) {
  const [filter, setFilter] = useState<"all" | "open_to_wl">("all");
  const [sort, setSort] = useState<"name" | "floor" | "potential">("potential");

  const filtered = apps.filter((a) => filter === "all" || a.reseller_openness === filter);
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "floor") return a.min_price_cents - b.min_price_cents;
    // sort by potential (high floor = more markup room, sort by abs potential)
    const potA = a.min_price_cents * 0.3;
    const potB = b.min_price_cents * 0.3;
    return potB - potA;
  });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-1.5 rounded-lg border border-border p-1">
          {(["all", "open_to_wl"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-[12px] px-2.5 py-1 rounded-md transition-colors ${
                filter === f
                  ? "bg-primary text-white font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {f === "all" ? "All tiers" : "WL Tier 2 eligible"}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          className="text-[12px] px-2.5 py-1.5 rounded-lg border border-border bg-surface text-foreground"
        >
          <option value="potential">Sort: potential earnings</option>
          <option value="floor">Sort: floor price</option>
          <option value="name">Sort: name</option>
        </select>
        <span className="ml-auto text-[12px] text-muted-foreground">{sorted.length} apps</span>
      </div>

      {sorted.length === 0 ? (
        <p className="text-[13px] text-muted-foreground text-center py-10">
          No resellable apps match your filter.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {sorted.map((app) => (
            <AppCard key={app.id} app={app} platformUrl={platformUrl} />
          ))}
        </div>
      )}
    </div>
  );
}
