import { ReactNode } from "react";
import { cn } from "./cn";

interface DenseTableProps {
  cols: string[];
  children?: ReactNode;
  empty?: ReactNode;
  className?: string;
}

export function DenseTable({ cols, children, empty, className }: DenseTableProps) {
  return (
    <div
      className={cn("text-sm overflow-hidden rounded-lg border border-border", className)}
      style={{ "--cols": cols.length } as React.CSSProperties}
      role="table"
      aria-label="data table"
    >
      {/* Head */}
      <div
        className={cn("grid gap-x-4 px-4 py-2.5 bg-muted border-b border-border")}
        style={{ gridTemplateColumns: `repeat(${cols.length}, 1fr)` }}
        role="row"
      >
        {cols.map((col) => (
          <div
            key={col}
            className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
            role="columnheader"
          >
            {col}
          </div>
        ))}
      </div>

      {/* Body */}
      <div role="rowgroup" className="divide-y divide-border-soft bg-surface">
        {children ?? (
          empty && (
            <div className="py-10 flex items-center justify-center">{empty}</div>
          )
        )}
      </div>
    </div>
  );
}

interface DenseRowProps {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  cols?: number;
}

export function DenseRow({ children, onClick, className, cols }: DenseRowProps) {
  return (
    <div
      className={cn(
        "grid gap-x-4 px-4 py-3 items-center transition-colors",
        onClick && "cursor-pointer hover:bg-muted/50",
        className,
      )}
      style={
        cols
          ? { gridTemplateColumns: `repeat(${cols}, 1fr)` }
          : { gridTemplateColumns: "repeat(var(--cols,1), 1fr)" }
      }
      onClick={onClick}
      role="row"
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

interface DenseCellProps {
  children?: ReactNode;
  align?: "left" | "center" | "right";
  className?: string;
}

export function DenseCell({ children, align = "left", className }: DenseCellProps) {
  return (
    <div
      className={cn(
        "truncate text-sm text-foreground",
        align === "right" && "text-right tabular-nums",
        align === "center" && "text-center",
        className,
      )}
      role="cell"
    >
      {children}
    </div>
  );
}
