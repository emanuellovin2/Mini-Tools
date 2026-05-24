import { Sparkline } from "@/components/ui/Sparkline";
import { formatPrice } from "@/lib/services/apps";
import type { SpendMonth } from "@/lib/services/buyer";

export function SpendSparkline({ history }: { history: SpendMonth[] }) {
  if (history.length === 0) return null;

  const total = history[history.length - 1]?.total_cents ?? 0;
  const prev = history[history.length - 2]?.total_cents ?? 0;
  const delta = total - prev;
  const points = history.map((m) => m.total_cents / 100);

  return (
    <div className="border border-border rounded-xl p-4 flex items-center justify-between gap-4">
      <div>
        <p className="text-xs text-muted-foreground mb-0.5">This month</p>
        <p className="text-lg font-bold">{formatPrice(total, "usd")}</p>
        {prev > 0 && (
          <p
            className={`text-xs mt-0.5 ${delta > 0 ? "text-amber-600" : delta < 0 ? "text-green-600" : "text-muted-foreground"}`}
          >
            {delta > 0 ? "+" : ""}
            {formatPrice(Math.abs(delta), "usd")} vs last month
          </p>
        )}
      </div>
      {points.length > 1 && (
        <Sparkline
          points={points}
          width={80}
          height={32}
          className="text-primary"
        />
      )}
    </div>
  );
}
