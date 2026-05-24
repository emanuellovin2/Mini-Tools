import { createAdminClient } from "@/lib/services/supabase";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

export interface DbOpts {
  // true  → primary always. Required for any path that reads then writes money.
  // false → replica eligible (dashboard reads, marketplace browse, public profiles).
  // Default: true (safe default; primary).
  freshRequired?: boolean;
  // true  → read-only; eligible for replica routing when freshRequired=false.
  readOnly?: boolean;
  // Optional region hint for future multi-region routing.
  region?: string;
}

// ---------------------------------------------------------------------------
// Per-role connection-budget documentation
// (enforced at Supavisor pool layer, not application code)
// ---------------------------------------------------------------------------
// vendor:        30% of connection budget
// agency:        30% of connection budget
// client:        30% of connection budget
// admin + cron:  10% of connection budget
// Prevents one role from starving the others under load.
// Configure in Supabase Dashboard → Database → Connection Pooling.
// ---------------------------------------------------------------------------

// Money-critical paths that MUST use freshRequired: true
// (see docs/money-critical-reads.md for the full audit checklist)
export const MONEY_CRITICAL_PATHS = [
  "recordUsage",
  "processPendingTransfers",
  "handleInvoicePaid",
  "handleChargeRefunded",
  "handleDisputeClosed",
  "settlementJob",
  "creditWalletTopUp",
] as const;

/**
 * Returns the appropriate DB client given the access pattern.
 *
 * freshRequired: true  → primary. Use for any path that reads then writes money.
 * readOnly: true, freshRequired: false → replica eligible (currently same as primary).
 *
 * Current impl returns the primary for everything — adding a read replica is a
 * one-line config change here; service code never needs to change.
 */
export function getDb(opts: DbOpts = {}): SupabaseClient<Database> {
  const { freshRequired = true } = opts;

  // When freshRequired is explicitly false AND readOnly, route to replica.
  // Current impl: no replica configured → fall through to primary.
  // Future: return createReplicaClient() when SUPABASE_REPLICA_URL is set.
  if (!freshRequired && opts.readOnly && process.env.SUPABASE_REPLICA_URL) {
    // Replica path — implement when replica is provisioned:
    // return createReplicaClient();
  }

  // Default: primary client.
  // Server components use the SSR client (respects the session cookie).
  // Service-layer code (admin paths) uses the admin client.
  try {
    // Attempt to get the server (session-aware) client.
    // Falls back to admin if called outside request context.
    return createServerSupabaseClient() as unknown as SupabaseClient<Database>;
  } catch {
    return createAdminClient() as unknown as SupabaseClient<Database>;
  }
}

/** Convenience — always reads from primary; use in any money-critical path. */
export const getDbFresh = () => getDb({ freshRequired: true });

/** Convenience — replica eligible; use for dashboards and public browse. */
export const getDbReadOnly = () => getDb({ freshRequired: false, readOnly: true });
