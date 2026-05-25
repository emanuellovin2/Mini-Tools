import { HTMLAttributes } from "react";
import { cn } from "./cn";

type BadgeVariant =
  | "default"
  | "secondary"
  | "success"
  | "warning"
  | "destructive"
  | "ok"
  | "warn"
  | "bad"
  | "outline";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClasses: Record<BadgeVariant, string> = {
  default:     "bg-primary/10 text-primary border border-primary/20",
  secondary:   "bg-muted text-muted-foreground border border-border",
  outline:     "border border-border text-foreground bg-transparent",
  ok:          "bg-ok-soft text-ok border border-ok/20",
  warn:        "bg-warn-soft text-warn border border-warn/20",
  bad:         "bg-bad-soft text-bad border border-bad/20",
  success:     "bg-ok-soft text-ok border border-ok/20",
  warning:     "bg-warn-soft text-warn border border-warn/20",
  destructive: "bg-bad-soft text-bad border border-bad/20",
};

export function Badge({
  className,
  variant = "secondary",
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
