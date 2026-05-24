"use client";

import { useRouter } from "next/navigation";
import type { MarketplaceParams } from "@/lib/validation/marketplace";
import { SORT_OPTIONS, buildMarketplaceHref } from "@/lib/validation/marketplace";

export function SortDropdown({ params }: { params: MarketplaceParams }) {
  const router = useRouter();

  return (
    <select
      value={params.sort}
      onChange={(e) =>
        router.push(
          buildMarketplaceHref(params, {
            sort: e.target.value as MarketplaceParams["sort"],
            page: 1,
          })
        )
      }
      className="border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
      aria-label="Sort apps"
    >
      {SORT_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
