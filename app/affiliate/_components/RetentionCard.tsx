import type { AffiliateRetention } from "@/lib/services/affiliate";

export default function RetentionCard({ retention }: { retention: AffiliateRetention }) {
  const { original_count, active_now, retention_pct } = retention;

  const INDUSTRY_AVG = 40; // % — typical SaaS 6-month retention benchmark
  const delta = retention_pct - INDUSTRY_AVG;

  if (original_count === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        Not enough data yet — needs subs that are at least 6 months old.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-4">
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">
            6-month retention
          </p>
          <p className="text-[36px] font-bold tabular-nums text-foreground leading-none">
            {retention_pct}%
          </p>
          <p className="text-[12px] text-muted-foreground mt-1">
            {active_now} of {original_count} subs from 6+ months ago still active
          </p>
        </div>

        <div className={`text-[13px] font-medium ${delta >= 0 ? "text-ok" : "text-bad"}`}>
          {delta >= 0 ? "↑" : "↓"} {Math.abs(delta)}pp vs industry avg ({INDUSTRY_AVG}%)
        </div>
      </div>

      {/* Simple visual bar */}
      <div>
        <div className="h-2 bg-muted rounded-full overflow-hidden mb-1">
          <div
            className="h-full rounded-full"
            style={{
              width: `${retention_pct}%`,
              background: delta >= 0 ? "var(--ok)" : "var(--warn)",
            }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>0%</span>
          <span>Industry avg: {INDUSTRY_AVG}%</span>
          <span>100%</span>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        High retention means you&apos;re driving quality traffic. Low retention may indicate a mismatch between your audience and the apps you promote.
      </p>
    </div>
  );
}
