// ---------------------------------------------------------------------------
// Solutions search — factory + singleton.
// Interface: lib/search/index.ts
// Postgres impl: lib/search/postgres/solutions.ts
// Health: lib/search/health.ts
//
// All marketplace listing pages route through solutionsIndex.
// Never query the solutions table directly from page code.
// ---------------------------------------------------------------------------

export type { SearchFilters, SearchOpts, SearchResult, SearchIndex } from "@/lib/search/index";
export { getSolutionsIndexHealth } from "@/lib/search/health";
export { pageNumberToCursor } from "@/lib/search/postgres/solutions";

import type { MarketplaceApp } from "@/lib/services/apps";
import type { SearchIndex } from "@/lib/search/index";
import { PostgresSolutionsIndex } from "@/lib/search/postgres/solutions";

function createSolutionsIndex(): SearchIndex<MarketplaceApp> {
  // Future: if (process.env.SEARCH_PROVIDER === 'algolia') return new AlgoliaSolutionsIndex();
  return new PostgresSolutionsIndex();
}

// Singleton — one index instance per process
export const solutionsIndex: SearchIndex<MarketplaceApp> = createSolutionsIndex();
