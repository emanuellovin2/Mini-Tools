import { cn } from "@/components/ui/cn";

interface StarRatingProps {
  avg: number;
  count?: number;
  size?: "sm" | "md";
  className?: string;
}

export function StarRating({ avg, count, size = "sm", className }: StarRatingProps) {
  const filled = Math.round(avg);

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <span className="flex gap-0.5" aria-label={`${avg.toFixed(1)} out of 5 stars`}>
        {[1, 2, 3, 4, 5].map((star) => (
          <span
            key={star}
            className={cn(
              size === "sm" ? "text-xs" : "text-sm",
              star <= filled ? "text-amber-400" : "text-gray-300"
            )}
          >
            ★
          </span>
        ))}
      </span>
      <span className={cn("text-muted-foreground", size === "sm" ? "text-[11px]" : "text-xs")}>
        {avg.toFixed(1)}
        {count != null && <span className="ml-0.5">({count})</span>}
      </span>
    </div>
  );
}

export function StarInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          className={cn(
            "text-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded transition-colors",
            star <= value ? "text-amber-400" : "text-gray-300 hover:text-amber-300"
          )}
          aria-label={`Rate ${star} star${star > 1 ? "s" : ""}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}
