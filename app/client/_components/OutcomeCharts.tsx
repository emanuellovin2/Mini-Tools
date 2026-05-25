import type { OutcomeSummary } from "@/lib/services/outcomes";

function formatValue(value: number, unit: string): string {
  if (unit === "usd") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value / 100);
  }
  if (unit === "hours") return `${value.toLocaleString()}h`;
  if (unit === "minutes") return `${value.toLocaleString()}m`;
  if (unit === "percent") return `${value.toFixed(1)}%`;
  return value.toLocaleString();
}

function labelFromKey(key: string): string {
  const last = key.split(".").pop() ?? key;
  return last.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function OutcomeCharts({ rows }: { rows: OutcomeSummary[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold mb-3">Outcomes (last 30 days)</h2>
        <p className="text-sm text-muted-foreground">No outcome data yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border p-5">
      <h2 className="text-sm font-semibold mb-4">Outcomes (last 30 days)</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {rows.map((row) => (
          <div
            key={row.metric_key}
            className="rounded-lg border border-border/60 bg-surface p-3"
          >
            <p className="text-xs text-muted-foreground truncate">{labelFromKey(row.metric_key)}</p>
            <p className="text-lg font-semibold mt-0.5 text-foreground">
              {formatValue(row.total_value, row.metric_unit)}
            </p>
            {row.trend_pct !== null && (
              <p
                className={`text-xs mt-0.5 ${
                  row.trend_pct >= 0 ? "text-green-600" : "text-destructive"
                }`}
              >
                {row.trend_pct >= 0 ? "+" : ""}
                {row.trend_pct.toFixed(1)}% vs prior period
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
