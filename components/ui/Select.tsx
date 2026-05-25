import { SelectHTMLAttributes, forwardRef } from "react";
import { cn } from "./cn";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-border bg-surface px-3 py-1 text-sm text-foreground",
        "shadow-sm appearance-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:border-primary/50",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted",
        "transition-shadow",
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = "Select";
