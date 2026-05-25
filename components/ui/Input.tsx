import { InputHTMLAttributes, forwardRef } from "react";
import { cn } from "./cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-border bg-surface px-3 py-1 text-sm text-foreground",
        "placeholder:text-muted-foreground",
        "shadow-sm",
        "transition-shadow",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:border-primary/50",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
