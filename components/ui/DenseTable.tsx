import { ReactNode } from "react";
import { cn } from "./cn";

/* Grid-based dense table — NOT a <table> element.
   Usage:
     <DenseTable cols={["Name", "MRR", "Status"]} empty={<EmptyState .../>}>
       <DenseRow onClick={...}>
         <DenseCell>…</DenseCell>
         <DenseCell align="right">…</DenseCell>
       </DenseRow>
     </DenseTable>
*/

interface DenseTableProps {
  cols: string[];
  children?: ReactNode;
  empty?: ReactNode;
  className?: string;
}

export function DenseTable({ cols, children, empty, className }: DenseTableProps) {
  const gridCols = `grid-cols-${cols.length}`;
  return (
    <div
      className={cn("text-[13px]", className)}
      style={{ "--cols": cols.length } as React.CSSProperties}
      role="table"
      aria-label="data table"
    >
      {/* Head */}
      <div
        className={cn(
          "grid gap-x-3 px-3 py-2 border-b border-border bg-muted/50",
          "rounded-t-lg",
          gridCols,
        )}
        role="row"
      >
        {cols.map((col) => (
          <div
            key={col}
            className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            role="columnheader"
          >
            {col}
          </div>
        ))}
      </div>

      {/* Body */}
      <div role="rowgroup">
        {children ?? (empty && (
          <div className="py-8 flex items-center justify-center">{empty}</div>
        ))}
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
  const gridCols = cols ? `grid-cols-${cols}` : undefined;
  return (
    <div
      className={cn(
        "grid gap-x-3 px-3 py-2.5 border-b border-border-soft last:border-0",
        "items-center transition-colors",
        onClick && "cursor-pointer hover:bg-muted/40",
        gridCols,
        !gridCols && "grid-cols-[var(--cols,1)]",
        className,
      )}
      style={cols ? { gridTemplateColumns: `repeat(${cols}, 1fr)` } : undefined}
      onClick={onClick}
      role="row"
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
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
        "truncate text-[13px] text-foreground",
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
