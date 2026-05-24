// ---------------------------------------------------------------------------
// Search abstraction for solutions
// ---------------------------------------------------------------------------
// Current impl: Postgres FTS via list_marketplace_apps RPC.
// Future impl: swap out SearchIndex<MarketplaceApp> for Algolia/Meilisearch
//   by changing the factory at the bottom — service code never changes.
//
// All marketplace listing pages MUST route through this interface.
// Never query the solutions/apps table directly from page code.
// ---------------------------------------------------------------------------

import type { MarketplaceApp, MarketplaceListResult, MarketplaceSort } from "@/lib/services/apps";
import { listMarketplaceApps } from "@/lib/services/apps";
import type { SolutionType } from "@/lib/types/solutions";

// ---------------------------------------------------------------------------
// Interface contract
// ---------------------------------------------------------------------------

export interface SearchFilters {
  category?: string;
  search?: string;
  sort?: MarketplaceSort;
  priceMin?: number;
  priceMax?: number;
  ratingMin?: number;
  hasAffiliate?: boolean;
  hasTrial?: boolean;
  solutionType?: SolutionType;
}

export interface SearchCursor {
  page: number;
  pageSize: number;
}

export interface SearchResult {
  rows: MarketplaceApp[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SearchIndex<T> {
  search(filters: SearchFilters, cursor: SearchCursor): Promise<SearchResult & { rows: T[] }>;
  indexDocument(id: string, doc: T): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  bulkReindex(rows: AsyncIterable<T>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Postgres implementation (active — single source of truth for solutions table)
// ---------------------------------------------------------------------------

class PostgresSolutionsIndex implements SearchIndex<MarketplaceApp> {
  async search(
    filters: SearchFilters,
    cursor: SearchCursor
  ): Promise<SearchResult & { rows: MarketplaceApp[] }> {
    const result = await listMarketplaceApps({
      page: cursor.page,
      pageSize: cursor.pageSize,
      category: filters.category,
      search: filters.search,
      sort: filters.sort,
      priceMin: filters.priceMin,
      priceMax: filters.priceMax,
      ratingMin: filters.ratingMin,
      hasAffiliate: filters.hasAffiliate,
      hasTrial: filters.hasTrial,
    });

    return {
      rows: result.apps,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    };
  }

  // No-op for Postgres: the table IS the index.
  // The queue path exists so flipping to external search is a config change, not a code change.
  async indexDocument(_id: string, _doc: MarketplaceApp): Promise<void> {
    // no-op — Postgres FTS reads live from solutions table
  }

  async deleteDocument(_id: string): Promise<void> {
    // no-op — hard deletes via solutions table cascade to FTS automatically
  }

  async bulkReindex(_rows: AsyncIterable<MarketplaceApp>): Promise<void> {
    // no-op — FTS index maintained by Postgres triggers on solutions
  }
}

// ---------------------------------------------------------------------------
// Interface stubs (declared so #41/#42 consume this pattern from day 1)
// ---------------------------------------------------------------------------

// Future: lib/search/agents.ts and lib/search/workflows.ts will implement
// the same SearchIndex<T> interface for agent/workflow browse pages.
// Declared here to signal the contract; impls are NOT written until those tasks.

// ---------------------------------------------------------------------------
// Index health (surfaced in admin dashboard #36)
// ---------------------------------------------------------------------------

export interface SearchIndexHealth {
  backlogSize: number;
  lastIndexedAt: Date | null;
  status: "healthy" | "warn" | "critical";
}

export async function getSolutionsIndexHealth(): Promise<SearchIndexHealth> {
  // Postgres impl: backlog is always 0 (live table = live index).
  // External search impl: query the reindex job queue for backlog count.
  return {
    backlogSize: 0,
    lastIndexedAt: new Date(),
    status: "healthy",
  };
}

// ---------------------------------------------------------------------------
// Factory — swap implementation here without touching callers
// ---------------------------------------------------------------------------

function createSolutionsIndex(): SearchIndex<MarketplaceApp> {
  // Future: if (process.env.SEARCH_PROVIDER === 'algolia') return new AlgoliaSolutionsIndex();
  return new PostgresSolutionsIndex();
}

// Singleton — one index instance per process
export const solutionsIndex: SearchIndex<MarketplaceApp> = createSolutionsIndex();
