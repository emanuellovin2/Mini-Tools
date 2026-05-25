// ---------------------------------------------------------------------------
// Canonical SearchIndex<T> interface — all search surfaces implement this.
// Current impl: Postgres FTS. Future: Algolia / Meilisearch (config change only).
//
// Cursor format: opaque string encoding the last-seen sort key + id.
// Postgres impl encodes as base64(JSON) of {createdAt, id}; external impls
// use their own cursor tokens. Callers must treat it as opaque.
// ---------------------------------------------------------------------------

export interface SearchFilters {
  // `search` is the canonical text-query field (matches existing codebase usage).
  search?: string;
  category?: string;
  sort?: string;
  priceMin?: number;
  priceMax?: number;
  ratingMin?: number;
  hasAffiliate?: boolean;
  hasTrial?: boolean;
  productKind?: "hosted" | "gateway" | "workflow_template";
  solutionType?: string;
  region?: string;
}

export interface SearchOpts {
  // Opaque cursor string (base64url-encoded). Callers must treat as opaque.
  // Use `pageNumberToCursor(n)` from lib/search/solutions.ts for page-based UIs.
  cursor?: string;
  limit: number;
}

export interface SearchResult<T> {
  rows: T[];
  nextCursor?: string;
  total?: number;
  // Convenience field for page-number UIs. Not all implementations provide it.
  totalPages?: number;
}

export interface SearchIndex<T> {
  search(filters: SearchFilters, opts: SearchOpts): Promise<SearchResult<T>>;
  indexDocument(id: string, doc: T): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  bulkReindex(rows: AsyncIterable<T>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Index health — surfaced in admin dashboard
// ---------------------------------------------------------------------------

export interface SearchIndexHealth {
  backlogSize: number;
  lastIndexedAt: Date | null;
  status: "healthy" | "warn" | "critical";
}

// Thresholds: warn at 10k backlog, critical at 100k
export function classifyHealth(backlogSize: number): SearchIndexHealth["status"] {
  if (backlogSize >= 100_000) return "critical";
  if (backlogSize >= 10_000) return "warn";
  return "healthy";
}
