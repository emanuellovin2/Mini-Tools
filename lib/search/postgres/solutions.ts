import type { MarketplaceApp } from "@/lib/services/apps";
import { listMarketplaceApps } from "@/lib/services/apps";
import type { SearchIndex, SearchFilters, SearchOpts, SearchResult, SearchIndexHealth } from "@/lib/search/index";
import { classifyHealth } from "@/lib/search/index";
import type { MarketplaceSort } from "@/lib/services/apps";

// Cursor encodes page offset as base64(JSON) for forward compatibility with
// keyset pagination — external search providers use opaque cursor tokens.
function encodeCursor(page: number): string {
  return Buffer.from(JSON.stringify({ page })).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    return typeof parsed.page === "number" ? parsed.page : 1;
  } catch {
    return 1;
  }
}

/** Convert a 1-based URL page number to an opaque search cursor. */
export function pageNumberToCursor(page: number): string | undefined {
  return page > 1 ? encodeCursor(page) : undefined;
}

export class PostgresSolutionsIndex implements SearchIndex<MarketplaceApp> {
  async search(
    filters: SearchFilters,
    opts: SearchOpts
  ): Promise<SearchResult<MarketplaceApp>> {
    const pageSize = Math.min(opts.limit, 100);
    const page = opts.cursor ? decodeCursor(opts.cursor) : 1;

    const result = await listMarketplaceApps({
      page,
      pageSize,
      category: filters.category,
      search: filters.search,
      sort: filters.sort as MarketplaceSort | undefined,
      priceMin: filters.priceMin,
      priceMax: filters.priceMax,
      ratingMin: filters.ratingMin,
      hasAffiliate: filters.hasAffiliate,
      hasTrial: filters.hasTrial,
    });

    const hasMore = page < result.totalPages;
    return {
      rows: result.apps,
      total: result.total,
      totalPages: result.totalPages,
      nextCursor: hasMore ? encodeCursor(page + 1) : undefined,
    };
  }

  // Postgres impl: table IS the index — these are no-ops.
  async indexDocument(_id: string, _doc: MarketplaceApp): Promise<void> {}
  async deleteDocument(_id: string): Promise<void> {}
  async bulkReindex(_rows: AsyncIterable<MarketplaceApp>): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Index health — Postgres always has 0 backlog (live table = live index)
// ---------------------------------------------------------------------------

export async function getPostgresSolutionsHealth(): Promise<SearchIndexHealth> {
  return {
    backlogSize: 0,
    lastIndexedAt: new Date(),
    status: classifyHealth(0),
  };
}
