import { ReactNode } from "react";
import { cn } from "./cn";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: string;
  cta?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, body, cta, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-12 px-6",
        className,
      )}
    >
      {icon && (
        <div className="w-10 h-10 rounded-full bg-muted border border-border flex items-center justify-center mb-4 text-muted-foreground">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {body && (
        <p className="text-sm text-muted-foreground mt-1 max-w-xs leading-relaxed">
          {body}
        </p>
      )}
      {cta && <div className="mt-4">{cta}</div>}
    </div>
  );
}
