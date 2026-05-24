import { ReactNode } from "react";
import { cn } from "./cn";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: string;
  cta: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, body, cta, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-10 px-4",
        className,
      )}
    >
      {icon && (
        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center mb-3 text-muted-foreground">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-foreground mb-1">{title}</p>
      {body && <p className="text-[12px] text-muted-foreground mb-4 max-w-xs">{body}</p>}
      <div className="mt-1">{cta}</div>
    </div>
  );
}
