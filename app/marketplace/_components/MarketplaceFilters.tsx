"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { MarketplaceParams } from "@/lib/validation/marketplace";
import { buildMarketplaceHref } from "@/lib/validation/marketplace";

const RATING_OPTIONS = [
  { label: "Any rating", value: undefined },
  { label: "3+ stars", value: 3 },
  { label: "4+ stars", value: 4 },
  { label: "4.5+ stars", value: 4.5 },
];

function FilterContent({
  params,
  onClose,
}: {
  params: MarketplaceParams;
  onClose?: () => void;
}) {
  const router = useRouter();
  const [priceMin, setPriceMin] = useState(
    params.priceMin != null ? String(params.priceMin / 100) : ""
  );
  const [priceMax, setPriceMax] = useState(
    params.priceMax != null ? String(params.priceMax / 100) : ""
  );

  function applyFilters(overrides: Partial<MarketplaceParams>) {
    const minCents =
      priceMin !== "" ? Math.round(parseFloat(priceMin) * 100) : undefined;
    const maxCents =
      priceMax !== "" ? Math.round(parseFloat(priceMax) * 100) : undefined;
    router.push(
      buildMarketplaceHref(
        { ...params, priceMin: minCents, priceMax: maxCents },
        { page: 1, ...overrides }
      )
    );
    onClose?.();
  }

  const hasFilters =
    params.priceMin != null ||
    params.priceMax != null ||
    params.ratingMin != null ||
    params.hasAffiliate != null ||
    params.hasTrial != null;

  return (
    <div className="space-y-5 text-sm">
      {/* Price range */}
      <div>
        <p className="font-medium mb-2 text-foreground">Price / month</p>
        <div className="flex gap-2 items-center">
          <input
            type="number"
            min={0}
            placeholder="$0"
            value={priceMin}
            onChange={(e) => setPriceMin(e.target.value)}
            onBlur={() => applyFilters({})}
            className="w-full border border-border rounded-md px-2 py-1.5 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-primary/30"
            aria-label="Minimum price"
          />
          <span className="text-muted-foreground shrink-0">–</span>
          <input
            type="number"
            min={0}
            placeholder="$200"
            value={priceMax}
            onChange={(e) => setPriceMax(e.target.value)}
            onBlur={() => applyFilters({})}
            className="w-full border border-border rounded-md px-2 py-1.5 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-primary/30"
            aria-label="Maximum price"
          />
        </div>
      </div>

      {/* Rating */}
      <div>
        <p className="font-medium mb-2 text-foreground">Minimum rating</p>
        <div className="flex flex-col gap-1">
          {RATING_OPTIONS.map((opt) => (
            <button
              key={opt.value ?? "any"}
              type="button"
              onClick={() => applyFilters({ ratingMin: opt.value })}
              className={`text-left px-2 py-1 rounded-md text-xs transition-colors ${
                params.ratingMin === opt.value
                  ? "bg-primary/10 text-primary font-medium"
                  : "hover:bg-muted text-muted-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Affiliate program */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={params.hasAffiliate === true}
          onChange={(e) =>
            applyFilters({ hasAffiliate: e.target.checked ? true : undefined })
          }
          className="accent-primary"
        />
        <span className="text-xs text-foreground">Has affiliate program</span>
      </label>

      {/* Free trial */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={params.hasTrial === true}
          onChange={(e) =>
            applyFilters({ hasTrial: e.target.checked ? true : undefined })
          }
          className="accent-primary"
        />
        <span className="text-xs text-foreground">Has free trial</span>
      </label>

      {/* Clear */}
      {hasFilters && (
        <button
          type="button"
          onClick={() =>
            router.push(
              buildMarketplaceHref(params, {
                priceMin: undefined,
                priceMax: undefined,
                ratingMin: undefined,
                hasAffiliate: undefined,
                hasTrial: undefined,
                page: 1,
              })
            )
          }
          className="text-xs text-primary underline mt-1"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

/* Desktop sidebar (always visible) */
export function FilterSidebar({ params }: { params: MarketplaceParams }) {
  return (
    <aside className="hidden lg:block w-52 shrink-0">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
        Filters
      </p>
      <FilterContent params={params} />
    </aside>
  );
}

/* Mobile filter sheet */
export function FilterSheet({ params }: { params: MarketplaceParams }) {
  const [open, setOpen] = useState(false);

  const hasFilters =
    params.priceMin != null ||
    params.priceMax != null ||
    params.ratingMin != null ||
    params.hasAffiliate != null ||
    params.hasTrial != null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="lg:hidden flex items-center gap-1.5 border border-border rounded-lg px-3 py-2 text-sm bg-background hover:bg-muted transition-colors"
        aria-label="Open filters"
      >
        <span>Filters</span>
        {hasFilters && (
          <span className="w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
            •
          </span>
        )}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 bg-black/40 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="fixed bottom-0 left-0 right-0 z-50 bg-background rounded-t-2xl p-6 shadow-xl max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <p className="font-semibold text-foreground">Filters</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground text-sm"
              >
                ✕ Close
              </button>
            </div>
            <FilterContent params={params} onClose={() => setOpen(false)} />
          </div>
        </>
      )}
    </>
  );
}
