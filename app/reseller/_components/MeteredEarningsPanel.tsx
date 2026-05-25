"use client";

import type { MeteredEarningsRow } from "@/lib/services/reseller";

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

export default function MeteredEarningsPanel({
  rows,
  totalCents,
  days = 30,
}: {
  rows: MeteredEarningsRow[];
  totalCents: number;
  days?: number;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No metered product markup earned in the last {days} days.{" "}
        <span className="text-foreground">
          Create a metered offer on a gateway agent or workflow template to start earning per-unit markup.
        </span>
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums">{fmt(totalCents)}</span>
        <span className="text-xs text-muted-foreground">markup earned · last {days}d</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground border-b border-border">
            <th className="text-left py-1 font-medium">Product</th>
            <th className="text-right py-1 font-medium">Units sold</th>
            <th className="text-right py-1 font-medium">Your share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.solution_id} className="border-b border-border/50 last:border-0">
              <td className="py-1.5 text-foreground">{r.solution_name}</td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                {fmtUnits(r.units_sold)}
              </td>
              <td className="py-1.5 text-right tabular-nums font-medium">
                {fmt(r.reseller_share_cents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">
        95% of your per-unit markup. Platform takes 5% of markup on each unit consumed.
      </p>
    </div>
  );
}
