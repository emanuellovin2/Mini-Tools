import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "./cn";

type Variant = "default" | "secondary" | "destructive" | "ghost" | "link" | "outline";
type Size = "xs" | "sm" | "md" | "lg" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  default:
    "bg-primary text-white hover:bg-primary/90 shadow-sm",
  secondary:
    "bg-surface text-foreground border border-border hover:bg-muted shadow-sm",
  outline:
    "border border-border text-foreground bg-transparent hover:bg-muted",
  destructive:
    "bg-bad text-white hover:bg-bad/90 shadow-sm",
  ghost:
    "text-muted-foreground hover:bg-muted hover:text-foreground",
  link:
    "text-primary underline-offset-4 hover:underline p-0 h-auto shadow-none",
};

const sizeClasses: Record<Size, string> = {
  xs:   "h-6 px-2 text-xs rounded",
  sm:   "h-7 px-3 text-xs rounded-md gap-1.5",
  md:   "h-8 px-3.5 text-sm rounded-md gap-2",
  lg:   "h-9 px-4 text-sm rounded-md gap-2",
  icon: "h-8 w-8 rounded-md",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1",
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
