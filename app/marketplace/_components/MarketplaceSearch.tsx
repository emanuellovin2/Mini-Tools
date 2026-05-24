"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import type { MarketplaceParams } from "@/lib/validation/marketplace";
import { buildMarketplaceHref } from "@/lib/validation/marketplace";

export function MarketplaceSearch({ params }: { params: MarketplaceParams }) {
  const router = useRouter();
  const [value, setValue] = useState(params.search ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setValue(params.search ?? "");
  }, [params.search]);

  function handleChange(v: string) {
    setValue(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      router.push(buildMarketplaceHref(params, { search: v || undefined, page: 1 }));
    }, 300);
  }

  function handleClear() {
    setValue("");
    router.push(buildMarketplaceHref(params, { search: undefined, page: 1 }));
  }

  return (
    <div className="relative flex-1">
      <input
        type="search"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Search apps…"
        className="w-full border border-border rounded-lg px-4 py-2 pr-8 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
        aria-label="Search marketplace"
      />
      {value && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs px-1"
          aria-label="Clear search"
        >
          ✕
        </button>
      )}
    </div>
  );
}
