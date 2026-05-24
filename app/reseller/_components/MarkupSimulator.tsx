"use client";

import { useState, useTransition } from "react";
import type { MarkupSimResult } from "@/lib/services/reseller";

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`flex justify-between text-[12px] ${highlight ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default function MarkupSimulator({
  offerId,
  floorCents,
  currentPriceCents,
  onSimulate,
}: {
  offerId: string;
  floorCents: number;
  currentPriceCents: number;
  onSimulate: (offerId: string, newPriceCents: number) => Promise<MarkupSimResult>;
}) {
  const minPrice = floorCents + 100; // at least $1 above floor
  const maxPrice = floorCents * 5 || 100_00; // 5× floor or $100 cap
  const [priceCents, setPriceCents] = useState(currentPriceCents);
  const [result, setResult] = useState<MarkupSimResult | null>(null);
  const [, startTransition] = useTransition();

  function handleChange(val: number) {
    setPriceCents(val);
    startTransition(async () => {
      const r = await onSimulate(offerId, val);
      setResult(r);
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[12px] text-muted-foreground">Your price</span>
          <span className="text-[13px] font-semibold tabular-nums">{fmt(priceCents)}/mo</span>
        </div>
        <input
          type="range"
          min={minPrice}
          max={maxPrice}
          step={100}
          value={priceCents}
          onChange={(e) => handleChange(Number(e.target.value))}
          className="w-full accent-primary"
        />
        <div className="flex justify-between text-[11px] text-muted-foreground mt-0.5">
          <span>{fmt(minPrice)}</span>
          <span>{fmt(maxPrice)}</span>
        </div>
      </div>

      {result && (
        <div className="bg-muted/30 rounded-lg p-3 space-y-1.5">
          <Row label="Your price" value={fmt(result.sell_price_cents)} />
          <Row label="Vendor floor" value={fmt(result.vendor_floor_cents)} />
          <div className="border-t border-border my-1" />
          <Row label="Vendor share" value={fmt(result.vendor_share_cents)} />
          <Row label="Platform cut" value={fmt(result.platform_cut_cents)} />
          <Row label="Your share / sale" value={fmt(result.reseller_share_cents)} highlight />
          <p className="text-[11px] text-muted-foreground pt-1">
            ≈ {fmt(result.reseller_share_cents * 12)}/yr at this price with 1 subscriber
          </p>
        </div>
      )}
    </div>
  );
}
