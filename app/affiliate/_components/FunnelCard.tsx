import type { AffiliateFunnel } from "@/lib/services/affiliate";

function pct(num: number, denom: number) {
  if (denom === 0) return "—";
  return ((num / denom) * 100).toFixed(1) + "%";
}

function FunnelBar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const width = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 shrink-0 text-right">
        <span className="text-[12px] text-muted-foreground">{label}</span>
      </div>
      <div className="flex-1 h-6 bg-muted/40 rounded overflow-hidden relative">
        <div
          className="h-full rounded transition-all"
          style={{ width: `${width}%`, background: color }}
        />
        <span className="absolute inset-0 flex items-center px-2 text-[12px] font-semibold text-foreground">
          {value}
        </span>
      </div>
      <div className="w-12 shrink-0 text-[11px] text-muted-foreground text-right">
        {pct(value, total)}
      </div>
    </div>
  );
}

export default function FunnelCard({ funnel }: { funnel: AffiliateFunnel }) {
  const total = funnel.total_attributed;

  if (total === 0) {
    return (
      <p className="text-[13px] text-muted-foreground text-center py-6">
        No attributed subscriptions yet. Share your referral links to get started.
      </p>
    );
  }

  const steps = [
    { label: "Total paid", value: total, color: "hsl(var(--primary))" },
    { label: "Active now", value: funnel.currently_active, color: "#22c55e" },
    { label: "Active 30d+", value: funnel.active_30d, color: "#16a34a" },
    { label: "Active 90d+", value: funnel.active_90d, color: "#15803d" },
  ];

  return (
    <div className="space-y-3">
      {steps.map((s) => (
        <FunnelBar key={s.label} {...s} total={total} />
      ))}
      <p className="text-[11px] text-muted-foreground pt-1">
        Active 30d+ / 90d+ = subscriptions created at least 30/90 days ago that are still paying.
        Retention = {pct(funnel.active_90d, funnel.total_attributed)} of all-time paid subs still active at 90 days.
      </p>
    </div>
  );
}
