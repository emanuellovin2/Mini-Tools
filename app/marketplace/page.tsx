import Link from "next/link";
import type { Metadata } from "next";
import {
  listMarketplaceCategories,
  getFeaturedApps,
  formatPrice,
  formatRating,
  MARKETPLACE_PAGE_SIZE,
} from "@/lib/services/apps";
import { solutionsIndex } from "@/lib/search/solutions";
import {
  parseMarketplaceParams,
  buildMarketplaceHref,
} from "@/lib/validation/marketplace";
import { FeaturedCarousel } from "./_components/FeaturedCarousel";
import { MarketplaceSearch } from "./_components/MarketplaceSearch";
import { SortDropdown } from "./_components/SortDropdown";
import { FilterSidebar, FilterSheet } from "./_components/MarketplaceFilters";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = {
  title: "Marketplace — [PLATFORM]",
  description:
    "Discover and subscribe to independent SaaS tools built by developers.",
  openGraph: {
    title: "Marketplace — [PLATFORM]",
    description: "Discover and subscribe to independent SaaS tools.",
    type: "website",
  },
};

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const FIXED_CATEGORIES = [
  "Productivity",
  "Developer",
  "Marketing",
  "Finance",
  "AI",
];

export default async function MarketplacePage({ searchParams }: Props) {
  const raw = await searchParams;
  const params = parseMarketplaceParams(raw);
  const { page, category, search, sort, priceMin, priceMax, ratingMin, hasAffiliate, hasTrial } = params;

  const [{ rows: apps, total, totalPages }, categories, featured] = await Promise.all([
    solutionsIndex.search(
      { category, search, sort, priceMin, priceMax, ratingMin, hasAffiliate, hasTrial },
      { page, pageSize: MARKETPLACE_PAGE_SIZE }
    ),
    listMarketplaceCategories(),
    // Only fetch featured when on the default landing (no filters active)
    !search && !category && !priceMin && !priceMax && !ratingMin && !hasAffiliate && !hasTrial && page === 1
      ? getFeaturedApps(5)
      : Promise.resolve([]),
  ]);

  const allCategories = Array.from(
    new Set([...FIXED_CATEGORIES, ...categories])
  );

  const isFiltered =
    search || category || priceMin != null || priceMax != null ||
    ratingMin != null || hasAffiliate != null || hasTrial != null;

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <Link href="/" className="text-xs text-muted-foreground hover:text-foreground mb-1 inline-block">
            [PLATFORM]
          </Link>
          <h1 className="text-2xl font-bold">Marketplace</h1>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/legal/fees"
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            How fees work
          </Link>
          <Link
            href="/login"
            className="text-sm border border-border px-4 py-2 rounded-lg hover:bg-muted transition-colors"
          >
            Sign in
          </Link>
        </div>
      </div>

      {/* Featured carousel — only on unfiltered first page */}
      {featured.length > 0 && <FeaturedCarousel apps={featured} />}

      {/* Search + sort + mobile filters row */}
      <div className="flex gap-2 mb-5">
        <MarketplaceSearch params={params} />
        <FilterSheet params={params} />
        <SortDropdown params={params} />
      </div>

      {/* Category pills */}
      {allCategories.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6 overflow-x-auto pb-1">
          <Link
            href={buildMarketplaceHref(params, { category: undefined, page: 1 })}
            className={`shrink-0 px-3 py-1 rounded-full text-xs border transition-colors ${
              !category
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border hover:bg-muted"
            }`}
          >
            All
          </Link>
          <Link
            href={buildMarketplaceHref(params, { category: "trending", page: 1 })}
            className={`shrink-0 px-3 py-1 rounded-full text-xs border transition-colors ${
              category === "trending"
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border hover:bg-muted"
            }`}
          >
            🔥 Trending
          </Link>
          {allCategories.map((cat) => (
            <Link
              key={cat}
              href={buildMarketplaceHref(params, { category: cat, page: 1 })}
              className={`shrink-0 px-3 py-1 rounded-full text-xs border transition-colors ${
                category === cat
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border hover:bg-muted"
              }`}
            >
              {cat}
            </Link>
          ))}
        </div>
      )}

      {/* Main content: sidebar + grid */}
      <div className="flex gap-8">
        <FilterSidebar params={params} />

        <div className="flex-1 min-w-0">
          {/* Result count */}
          <p className="text-xs text-muted-foreground mb-4">
            {total === 0
              ? "No apps found"
              : `${total} app${total === 1 ? "" : "s"}`}
            {search && (
              <span>
                {" "}
                matching &ldquo;{search}&rdquo;
              </span>
            )}
            {category && <span> in {category}</span>}
          </p>

          {/* App grid */}
          {apps.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
              {apps.map((app) => (
                <Link
                  key={app.id}
                  href={`/app/${app.id}`}
                  className="group flex flex-col border border-border rounded-xl overflow-hidden hover:border-primary/50 hover:shadow-sm transition-all"
                >
                  {/* Screenshot */}
                  {app.screenshot_urls[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={app.screenshot_urls[0]}
                      alt={`${app.name} screenshot`}
                      className="w-full aspect-[16/10] object-cover group-hover:opacity-95 transition-opacity"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full aspect-[16/10] bg-gradient-to-br from-muted to-muted/60" />
                  )}

                  <div className="p-4 flex flex-col flex-1">
                    <div className="flex justify-between items-start gap-2 mb-1">
                      <h2 className="font-semibold text-sm leading-snug">
                        {app.name}
                      </h2>
                      {app.category && (
                        <span className="shrink-0 text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full">
                          {app.category}
                        </span>
                      )}
                    </div>

                    {/* Rating */}
                    {app.rating_count > 0 && (
                      <div className="flex items-center gap-1 mb-1.5">
                        <span className="text-amber-400 text-xs">★</span>
                        <span className="text-xs text-muted-foreground">
                          {formatRating(app.rating_avg)}
                          <span className="ml-0.5">({app.rating_count})</span>
                        </span>
                      </div>
                    )}

                    {app.description && (
                      <p className="text-xs text-muted-foreground mb-3 line-clamp-2 flex-1">
                        {app.description}
                      </p>
                    )}

                    <div className="flex items-center justify-between mt-auto pt-2 gap-2">
                      <span className="text-sm font-semibold">
                        {formatPrice(app.price_cents, app.currency)}
                        <span className="text-muted-foreground font-normal text-xs ml-0.5">
                          /mo
                        </span>
                      </span>
                      <div className="flex items-center gap-1.5">
                        {app.has_free_trial && (
                          <span className="text-[9px] font-medium bg-green-50 text-green-700 border border-green-200 px-1.5 py-0.5 rounded-full">
                            Free trial
                          </span>
                        )}
                        {app.affiliate_commission_bps != null &&
                          app.affiliate_commission_bps > 0 && (
                            <span className="text-[9px] font-medium bg-violet-50 text-violet-700 border border-violet-200 px-1.5 py-0.5 rounded-full">
                              {Math.round(app.affiliate_commission_bps / 100)}%
                              affiliate
                            </span>
                          )}
                      </div>
                    </div>

                    {app.subscriber_count > 0 && (
                      <p className="text-[10px] text-muted-foreground mt-1.5">
                        {app.subscriber_count} subscriber
                        {app.subscriber_count !== 1 ? "s" : ""}
                      </p>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No apps match your filters"
              body={
                isFiltered
                  ? "Try adjusting your search or filters."
                  : "No apps are available yet."
              }
              cta={
                isFiltered ? (
                  <Link
                    href="/marketplace"
                    className="text-sm text-primary underline"
                  >
                    Clear all filters
                  </Link>
                ) : undefined
              }
              className="border border-dashed border-border rounded-xl py-20"
            />
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-4">
              {page > 1 ? (
                <Link
                  href={buildMarketplaceHref(params, { page: page - 1 })}
                  className="border border-border px-4 py-2 rounded-lg text-sm hover:bg-muted transition-colors"
                >
                  ← Previous
                </Link>
              ) : (
                <span className="px-4 py-2 rounded-lg text-sm text-muted-foreground border border-border/40">
                  ← Previous
                </span>
              )}
              <span className="text-sm text-muted-foreground">
                {page} / {totalPages}
              </span>
              {page < totalPages ? (
                <Link
                  href={buildMarketplaceHref(params, { page: page + 1 })}
                  className="border border-border px-4 py-2 rounded-lg text-sm hover:bg-muted transition-colors"
                >
                  Next →
                </Link>
              ) : (
                <span className="px-4 py-2 rounded-lg text-sm text-muted-foreground border border-border/40">
                  Next →
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
