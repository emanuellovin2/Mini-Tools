import { ReactNode } from "react";
import { cn } from "./cn";
import { Sparkline } from "./Sparkline";

interface KpiCardProps {
  label: string;
  value: string | number;
  sub?: string;
  delta?: number;
  deltaLabel?: string;
  sparkline?: number[];
  sparklineColor?: string;
  className?: string;
  children?: ReactNode;
}

function DeltaChip({ delta, label }: { delta: number; label?: string }) {
  const up = delta >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded-full",
        up ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad",
      )}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
        {up ? (
          <path d="M5 2L9 7H1L5 2Z" />
        ) : (
          <path d="M5 8L1 3H9L5 8Z" />
        )}
      </svg>
      {Math.abs(delta).toFixed(1)}%
      {label && <span className="opacity-60 ml-0.5">{label}</span>}
    </span>
  );
}

export function KpiCard({
  label,
  value,
  sub,
  delta,
  deltaLabel,
  sparkline,
  sparklineColor,
  className,
  children,
}: KpiCardProps) {
  return (
    <div
      className={cn(
        "bg-surface rounded-lg border border-border p-5",
        "shadow-[var(--shadow-card)]",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {label}
          </p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground leading-none">
            {value}
          </p>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {delta !== undefined && (
              <DeltaChip delta={delta} label={deltaLabel} />
            )}
            {sub && (
              <span className="text-xs text-muted-foreground">{sub}</span>
            )}
          </div>
        </div>
        {sparkline && sparkline.length >= 2 && (
          <Sparkline
            points={sparkline}
            color={sparklineColor ?? "hsl(var(--primary))"}
            width={72}
            height={32}
          />
        )}
      </div>
      {children && <div className="mt-4 pt-4 border-t border-border">{children}</div>}
    </div>
  );
}
