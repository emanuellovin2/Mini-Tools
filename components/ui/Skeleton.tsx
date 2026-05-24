import { HTMLAttributes } from "react";
import { cn } from "./cn";

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "rect" | "line" | "avatar";
  lines?: number;
}

export function Skeleton({ className, variant = "rect", lines, ...props }: SkeletonProps) {
  if (variant === "avatar") {
    return (
      <div
        className={cn("animate-pulse rounded-full bg-muted shrink-0", className)}
        style={{ width: 32, height: 32, ...props.style }}
        {...props}
      />
    );
  }

  if (variant === "line" && lines && lines > 1) {
    return (
      <div className="space-y-2">
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className={cn(
              "animate-pulse rounded bg-muted h-3",
              i === lines - 1 && "w-3/4",
              className,
            )}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "animate-pulse bg-muted",
        variant === "line" ? "rounded h-3 w-full" : "rounded-lg",
        className,
      )}
      {...props}
    />
  );
}
