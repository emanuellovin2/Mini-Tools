import type { Funnel } from "@/lib/analytics/funnel";

function FunnelBar({
  label,
  count,
  uniqueVisitors,
  max,
  conversionPct,
}: {
  label: string;
  count: number;
  uniqueVisitors: number;
  max: number;
  conversionPct: number | null;
}) {
  const width = max > 0 ? Math.round((uniqueVisitors / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-32 shrink-0 text-right">
        <span className="text-[12px] text-muted-foreground">{label}</span>
      </div>
      <div className="flex-1 h-6 bg-muted/40 rounded overflow-hidden relative">
        <div
          className="h-full rounded transition-all bg-primary/70"
          style={{ width: `${width}%` }}
        />
        <span className="absolute inset-0 flex items-center px-2 text-[12px] font-semibold text-foreground">
          {uniqueVisitors.toLocaleString()} unique · {count.toLocaleString()} events
        </span>
      </div>
      <div className="w-16 shrink-0 text-[11px] text-muted-foreground text-right">
        {conversionPct !== null ? `${conversionPct.toFixed(1)}%` : "—"}
      </div>
    </div>
  );
}

export default function VendorFunnelCard({
  funnel,
  byApp,
}: {
  funnel: Funnel;
  byApp: Array<{ app_id: string; app_name: string; funnel: Funnel }>;
}) {
  const max = Math.max(1, ...funnel.stages.map((s) => s.unique_visitors));
  const hasData = funnel.stages.some((s) => s.unique_visitors > 0);

  if (!hasData) {
    return (
      <p className="text-[13px] text-muted-foreground text-center py-6">
        No analytics events captured yet. Top-of-funnel data appears once your apps see traffic.
      </p>
    );
  }

  const topByApp = byApp
    .map((row) => {
      const bottom = row.funnel.stages[row.funnel.stages.length - 1]?.unique_visitors ?? 0;
      const top = row.funnel.stages[0]?.unique_visitors ?? 0;
      return { ...row, top, bottom };
    })
    .filter((row) => row.top > 0)
    .sort((a, b) => b.top - a.top)
    .slice(0, 5);

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        {funnel.stages.map((s) => (
          <FunnelBar
            key={s.event_type}
            label={s.label}
            count={s.count}
            uniqueVisitors={s.unique_visitors}
            max={max}
            conversionPct={s.conversion_pct}
          />
        ))}
        {funnel.overall_conversion_pct !== null && (
          <p className="text-[11px] text-muted-foreground pt-1">
            Overall impression → subscribed: {funnel.overall_conversion_pct.toFixed(2)}%
          </p>
        )}
      </div>

      {topByApp.length > 0 && (
        <div className="border-t border-border pt-4">
          <h3 className="text-[12px] font-semibold text-foreground mb-2">Top apps by impressions</h3>
          <div className="space-y-1.5">
            {topByApp.map((row) => (
              <div
                key={row.app_id}
                className="grid grid-cols-[1fr,auto,auto,auto] gap-3 items-center text-[12px]"
              >
                <span className="text-foreground truncate">{row.app_name}</span>
                <span className="text-muted-foreground tabular-nums">{row.top.toLocaleString()} impr</span>
                <span className="text-muted-foreground tabular-nums">{row.bottom.toLocaleString()} subs</span>
                <span className="text-muted-foreground tabular-nums w-12 text-right">
                  {row.funnel.overall_conversion_pct !== null
                    ? `${row.funnel.overall_conversion_pct.toFixed(1)}%`
                    : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
