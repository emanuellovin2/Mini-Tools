import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "./cn";

type Variant = "default" | "secondary" | "destructive" | "ghost" | "link" | "outline";
type Size = "sm" | "md" | "lg" | "icon" | "xs";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  default:
    "bg-primary text-white hover:opacity-90 shadow-sm",
  secondary:
    "bg-muted text-foreground hover:bg-muted/80 border border-border",
  outline:
    "border border-border text-foreground hover:bg-muted bg-transparent",
  destructive:
    "bg-bad text-white hover:opacity-90 shadow-sm",
  ghost:
    "hover:bg-muted text-foreground",
  link:
    "text-primary underline-offset-4 hover:underline p-0 h-auto",
};

const sizeClasses: Record<Size, string> = {
  xs: "h-6 px-2 text-[11px] rounded",
  sm: "h-7 px-3 text-xs rounded-md",
  md: "h-8 px-3.5 text-[13px] rounded-md",
  lg: "h-10 px-5 text-sm rounded-lg",
  icon: "h-8 w-8 rounded-md",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center font-medium transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
        "disabled:pointer-events-none disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
