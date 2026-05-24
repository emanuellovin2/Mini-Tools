import Link from "next/link";
import type { Metadata } from "next";
import {
  listMarketplaceApps,
  listMarketplaceCategories,
  formatPrice,
  MARKETPLACE_PAGE_SIZE,
} from "@/lib/services/apps";
import { parseMarketplaceParams } from "@/lib/validation/marketplace";

export const metadata: Metadata = {
  title: "Marketplace — [PLATFORM]",
  description: "Discover and subscribe to independent SaaS tools.",
};

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function MarketplacePage({ searchParams }: Props) {
  const raw = await searchParams;
  const { page, category, search } = parseMarketplaceParams(raw);

  const [{ apps, total, totalPages }, categories] = await Promise.all([
    listMarketplaceApps({ page, pageSize: MARKETPLACE_PAGE_SIZE, category, search }),
    listMarketplaceCategories(),
  ]);

  function href(overrides: { page?: number; category?: string; search?: string }) {
    const p = new URLSearchParams();
    const s = "search" in overrides ? overrides.search : search;
    const c = "category" in overrides ? overrides.category : category;
    const pg = overrides.page ?? (("search" in overrides || "category" in overrides) ? 1 : page);
    if (s) p.set("search", s);
    if (c) p.set("category", c);
    if (pg > 1) p.set("page", String(pg));
    const qs = p.toString();
    return `/marketplace${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <Link href="/" className="text-sm text-gray-700 hover:text-gray-900 mb-1 inline-block">
            [PLATFORM]
          </Link>
          <h1 className="text-2xl font-bold">Marketplace</h1>
        </div>
        <Link href="/login" className="text-sm border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-50 transition-colors">
          Sign in
        </Link>
      </div>

      {/* Search */}
      <form method="get" action="/marketplace" className="mb-5">
        {category && <input type="hidden" name="category" value={category} />}
        <div className="flex gap-2">
          <input
            name="search"
            defaultValue={search}
            placeholder="Search apps…"
            className="flex-1 border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
          />
          <button
            type="submit"
            className="bg-black text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
          >
            Search
          </button>
          {search && (
            <Link
              href={href({ search: undefined })}
              className="border border-gray-300 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors"
            >
              Clear
            </Link>
          )}
        </div>
      </form>

      {/* Category chips */}
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          <Link
            href={href({ category: undefined })}
            className={`px-3 py-1 rounded-full text-sm border transition-colors ${
              !category ? "bg-black text-white border-black" : "border-gray-300 hover:bg-gray-50"
            }`}
          >
            All
          </Link>
          {categories.map((cat) => (
            <Link
              key={cat}
              href={href({ category: cat })}
              className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                category === cat
                  ? "bg-black text-white border-black"
                  : "border-gray-300 hover:bg-gray-50"
              }`}
            >
              {cat}
            </Link>
          ))}
        </div>
      )}

      {/* Count */}
      <p className="text-sm text-gray-700 mb-5">
        {total === 0 ? "No apps found" : `${total} app${total === 1 ? "" : "s"}`}
        {search && <span> matching &ldquo;{search}&rdquo;</span>}
        {category && <span> in {category}</span>}
      </p>

      {/* Grid */}
      {apps.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          {apps.map((app) => (
            <Link
              key={app.id}
              href={`/app/${app.id}`}
              className="flex flex-col border border-gray-200 rounded-xl overflow-hidden hover:border-gray-400 hover:shadow-sm transition-all"
            >
              {/* Preview screenshot or gradient fallback */}
              {app.screenshot_urls[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={app.screenshot_urls[0]}
                  alt={`${app.name} screenshot`}
                  className="w-full aspect-[16/10] object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full aspect-[16/10] bg-gradient-to-br from-gray-100 to-gray-200" />
              )}

              <div className="p-5 flex flex-col flex-1">
                <div className="flex justify-between items-start gap-2 mb-2">
                  <h2 className="font-semibold text-base leading-snug">{app.name}</h2>
                  {app.category && (
                    <span className="shrink-0 text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">
                      {app.category}
                    </span>
                  )}
                </div>
                {app.description && (
                  <p className="text-sm text-gray-700 mb-3 line-clamp-2 flex-1">
                    {app.description}
                  </p>
                )}
                <div className="flex items-center justify-between mt-auto pt-2">
                  <span className="text-sm font-medium">
                    {formatPrice(app.price_cents, app.currency)}<span className="text-gray-700 font-normal">/mo</span>
                  </span>
                  {app.vendor_name && (
                    <span className="text-xs text-gray-700">by {app.vendor_name}</span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-center py-20 text-gray-700 border border-dashed border-gray-200 rounded-xl">
          <p className="text-sm">No apps match your filters.</p>
          <Link href="/marketplace" className="text-sm text-black underline mt-2 inline-block">
            Clear filters
          </Link>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 mt-4">
          {page > 1 ? (
            <Link
              href={href({ page: page - 1 })}
              className="border border-gray-300 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors"
            >
              ← Previous
            </Link>
          ) : (
            <span className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-100">
              ← Previous
            </span>
          )}
          <span className="text-sm text-gray-700">
            {page} / {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              href={href({ page: page + 1 })}
              className="border border-gray-300 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors"
            >
              Next →
            </Link>
          ) : (
            <span className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-100">
              Next →
            </span>
          )}
        </div>
      )}
    </div>
  );
}
