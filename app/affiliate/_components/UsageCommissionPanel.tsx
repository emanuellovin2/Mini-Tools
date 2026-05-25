"use client";

import type { AffiliateUsageEarningsRow } from "@/lib/services/affiliate";

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function fmtUnits(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}

export default function UsageCommissionPanel({
  rows,
  totalCents,
  days = 30,
}: {
  rows: AffiliateUsageEarningsRow[];
  totalCents: number;
  days?: number;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No usage commissions in the last {days} days.{" "}
        <span className="text-foreground">
          Refer buyers to metered products (Agent / Workflow) via your affiliate link to earn a recurring % of the platform fee on every unit they consume.
        </span>
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums">{fmt(totalCents)}</span>
        <span className="text-xs text-muted-foreground">usage commissions · last {days}d</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground border-b border-border">
            <th className="text-left py-1 font-medium">Product</th>
            <th className="text-right py-1 font-medium">Units consumed</th>
            <th className="text-right py-1 font-medium">Commission</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.solution_id} className="border-b border-border/50 last:border-0">
              <td className="py-1.5 text-foreground">{r.solution_name}</td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                {fmtUnits(r.units_consumed)}
              </td>
              <td className="py-1.5 text-right tabular-nums font-medium">
                {fmt(r.affiliate_share_cents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">
        Recurring commission — your snapshotted % of the platform fee on every unit your referred buyers consume, for the life of their subscription.
      </p>
    </div>
  );
}
