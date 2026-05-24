"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import { createAffiliateLinkAction } from "../actions";
import type { PromotableApp } from "@/lib/services/affiliate";

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

type SortKey = "commission" | "price" | "category";

function AppCard({
  app,
  commissionBps,
}: {
  app: PromotableApp;
  commissionBps: number; // affiliate's current tier commission
}) {
  const [generated, setGenerated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const appUrl = typeof window !== "undefined" ? window.location.origin : "";
  const vendorCommBps = app.affiliate_commission_bps;
  // The affiliate earns their tier rate (commissionBps) but we show vendor's set rate
  const monthlyEarnCents = Math.floor((app.price_cents * commissionBps) / 10_000);

  function handleGenerate() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("app_id", app.id);
      const res = await createAffiliateLinkAction(fd);
      if ("error" in res) {
        setError(res.error);
      } else {
        setGenerated(res.url);
      }
    });
  }

  async function copy() {
    if (!generated) return;
    await navigator.clipboard.writeText(generated);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const preview = app.screenshot_urls[0] ?? null;

  return (
    <div className="bg-surface rounded-[10px] border border-border shadow-[var(--shadow-card)] overflow-hidden flex flex-col">
      {/* Screenshot preview */}
      <div className="h-28 bg-muted relative overflow-hidden">
        {preview ? (
          <Image src={preview} alt={app.name} fill className="object-cover" />
        ) : app.logo_url ? (
          <Image src={app.logo_url} alt={app.name} fill className="object-contain p-4" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground text-[11px]">
            No preview
          </div>
        )}
        {/* Commission badge */}
        <span className="absolute top-2 right-2 text-[11px] font-bold bg-primary text-primary-foreground rounded-full px-2 py-0.5">
          {(vendorCommBps / 100).toFixed(0)}% commission
        </span>
      </div>

      <div className="p-3 flex-1 flex flex-col gap-2">
        <div>
          <p className="font-medium text-[13px] text-foreground leading-tight">{app.name}</p>
          {app.category && (
            <p className="text-[11px] text-muted-foreground mt-0.5">{app.category}</p>
          )}
        </div>

        <div className="text-[12px] text-muted-foreground flex-1">
          {app.description ? (
            <p className="line-clamp-2">{app.description}</p>
          ) : null}
        </div>

        {/* Projected earnings */}
        <div className="bg-muted/40 rounded-lg p-2 text-[12px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">List price</span>
            <span className="tabular-nums">{formatCents(app.price_cents)}/mo</span>
          </div>
          <div className="flex justify-between font-medium text-ok">
            <span>You earn per sub</span>
            <span className="tabular-nums">{formatCents(monthlyEarnCents)}/mo</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>10 subs →</span>
            <span className="tabular-nums">{formatCents(monthlyEarnCents * 10)}/mo</span>
          </div>
        </div>

        {/* Generate link */}
        {generated ? (
          <div className="flex items-center gap-2 mt-auto">
            <input
              readOnly
              value={generated}
              className="flex-1 text-[11px] font-mono bg-muted border border-border rounded px-2 py-1 truncate"
            />
            <button
              type="button"
              onClick={copy}
              className="text-[12px] px-2 py-1 rounded border border-border hover:bg-muted/40 transition-colors shrink-0"
            >
              {copied ? "✓" : "Copy"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isPending}
            className="mt-auto text-[13px] w-full py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {isPending ? "Generating…" : "Generate link"}
          </button>
        )}
        {error && <p className="text-[11px] text-bad">{error}</p>}
      </div>
    </div>
  );
}

export default function PromoteAppsSection({
  apps,
  affiliateCommissionBps,
}: {
  apps: PromotableApp[];
  affiliateCommissionBps: number;
}) {
  const [sort, setSort] = useState<SortKey>("commission");
  const [category, setCategory] = useState<string>("all");

  const categories = ["all", ...new Set(apps.map((a) => a.category).filter(Boolean) as string[])];

  const filtered = apps
    .filter((a) => category === "all" || a.category === category)
    .sort((a, b) => {
      if (sort === "commission") return b.affiliate_commission_bps - a.affiliate_commission_bps;
      if (sort === "price") return b.price_cents - a.price_cents;
      return (a.category ?? "").localeCompare(b.category ?? "");
    });

  if (apps.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-[13px] text-muted-foreground">
          No apps with affiliate programs are available yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={`text-[12px] px-3 py-1 rounded-full border transition-colors ${
                category === cat
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-border-dark"
              }`}
            >
              {cat === "all" ? "All" : cat}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">Sort:</span>
          {(["commission", "price", "category"] as SortKey[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              className={`text-[12px] px-2 py-1 rounded border transition-colors ${
                sort === s ? "bg-muted border-border" : "border-transparent text-muted-foreground"
              }`}
            >
              {s === "commission" ? "Commission ↓" : s === "price" ? "Price ↓" : "Category"}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((app) => (
          <AppCard key={app.id} app={app} commissionBps={affiliateCommissionBps} />
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="text-[13px] text-muted-foreground text-center py-6">
          No apps match the selected filter.
        </p>
      )}
    </div>
  );
}
