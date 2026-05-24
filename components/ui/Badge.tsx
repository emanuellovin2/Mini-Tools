import { HTMLAttributes } from "react";
import { cn } from "./cn";

type BadgeVariant = "default" | "secondary" | "success" | "warning" | "destructive" | "ok" | "warn" | "bad" | "outline";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClasses: Record<BadgeVariant, string> = {
  default:   "bg-primary text-white",
  secondary: "bg-muted text-muted-foreground border border-border",
  outline:   "border border-border text-foreground bg-transparent",
  ok:        "bg-ok-soft text-ok",
  warn:      "bg-warn-soft text-warn",
  bad:       "bg-bad-soft text-bad",
  // legacy aliases
  success:     "bg-ok-soft text-ok",
  warning:     "bg-warn-soft text-warn",
  destructive: "bg-bad-soft text-bad",
};

export function Badge({ className, variant = "secondary", children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
