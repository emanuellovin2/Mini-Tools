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
  const positive = delta >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] font-medium px-1.5 py-0.5 rounded",
        positive ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad",
      )}
    >
      <span className="text-[10px]">{positive ? "↑" : "↓"}</span>
      {Math.abs(delta).toFixed(1)}%{label && <span className="opacity-70 ml-0.5">{label}</span>}
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
        "bg-surface rounded-[10px] p-4 border border-border",
        "shadow-[var(--shadow-card)]",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide truncate">
            {label}
          </p>
          <p className="mt-1 text-[24px] font-semibold tabular-nums leading-none text-foreground">
            {value}
          </p>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            {delta !== undefined && <DeltaChip delta={delta} label={deltaLabel} />}
            {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
          </div>
        </div>
        {sparkline && sparkline.length >= 2 && (
          <Sparkline
            points={sparkline}
            color={sparklineColor ?? "hsl(var(--primary))"}
            width={72}
            height={28}
          />
        )}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
