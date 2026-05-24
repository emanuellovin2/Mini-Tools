// ---------------------------------------------------------------------------
// Cold-storage router stub.
//
// Dashboards (#52/#53/#36) MUST call through this router for any historical query.
// Direct table queries on ranges > 24 months old are forbidden.
//
// Current impl: always returns inline from hot table (single-region, no S3 yet).
// Future impl: ranges > 24 months → export parquet from S3 → return jobId;
//              dashboards poll /api/cold-storage/[jobId] for completion.
// ---------------------------------------------------------------------------

export interface ColdQueryOpts {
  /** Table name (e.g. 'analytics_events', 'usage_events', 'deployment_metrics') */
  table: string;
  /** Scoping entity — deployment_id, org_id, or entity_id depending on the table */
  entityId: string;
  from: Date;
  to: Date;
}

export type ColdQueryResult =
  | { type: "inline"; rows: unknown[] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { type: "async"; jobId: string; estimatedReadyAt: Date };

export interface ColdStorageRouter {
  queryRange(opts: ColdQueryOpts): Promise<ColdQueryResult>;
}

// Cold-data age threshold — queries spanning ranges older than this may be async.
export const COLD_STORAGE_THRESHOLD_MONTHS = 24;

class PassthroughColdStorageRouter implements ColdStorageRouter {
  async queryRange(_opts: ColdQueryOpts): Promise<ColdQueryResult> {
    // Current impl: always inline. Hot table has all data.
    // Future: if opts.from < cutoffDate → enqueue S3 export job, return { type: 'async', jobId, estimatedReadyAt }
    return { type: "inline", rows: [] };
  }
}

export const coldStorageRouter: ColdStorageRouter = new PassthroughColdStorageRouter();

/**
 * Helper: returns true if the query range overlaps cold storage territory.
 * Dashboards can use this to show a "Loading historical data..." indicator.
 */
export function spansColdStorage(from: Date): boolean {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - COLD_STORAGE_THRESHOLD_MONTHS);
  return from < cutoff;
}
