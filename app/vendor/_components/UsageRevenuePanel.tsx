"use client";

import type { UsageEarningsRow } from "@/lib/services/usage";

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

export default function UsageRevenuePanel({
  rows,
  totalCents,
  days = 30,
}: {
  rows: UsageEarningsRow[];
  totalCents: number;
  days?: number;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No metered product revenue in the last {days} days.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums">{fmt(totalCents)}</span>
        <span className="text-xs text-muted-foreground">last {days}d</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground border-b border-border">
            <th className="text-left py-1 font-medium">Product</th>
            <th className="text-right py-1 font-medium">Units</th>
            <th className="text-right py-1 font-medium">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.meterId} className="border-b border-border/50 last:border-0">
              <td className="py-1.5 text-foreground">{r.solutionName ?? r.meterId.slice(0, 8)}</td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                {fmtUnits(r.unitsSold)}
              </td>
              <td className="py-1.5 text-right tabular-nums font-medium">{fmt(r.totalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">
        Vendor share only. Platform fee, reseller markup, and affiliate commissions are excluded.
      </p>
    </div>
  );
}
