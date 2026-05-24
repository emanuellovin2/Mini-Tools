# Money-Critical Reads Audit Checklist

> Every code path that **reads then writes money values** MUST use `getDbFresh()` (or `getDb({ freshRequired: true })`).
> This ensures the read always hits the primary, never a stale replica.

## Reviewed paths — `freshRequired: true` required

| Path | File | Reason |
|---|---|---|
| `recordUsage` | `lib/services/analytics.ts` (#40) | Reads wallet balance before deducting credits |
| `processPendingTransfers` | `lib/stripe/webhook-handlers.ts` | Reads pending transfer amounts before Stripe transfer |
| `handleInvoicePaid` | `lib/stripe/webhook-handlers.ts` | Reads subscription + vendor cut before transfer |
| `handleChargeRefunded` | `lib/stripe/webhook-handlers.ts` | Reads transfer IDs before reversal |
| `handleDisputeClosed` | `lib/stripe/webhook-handlers.ts` | Reads all transfer IDs before reversal |
| `settlementJob` | `lib/jobs/handlers.ts` (#40) | Reads unsettled usage_events before aggregating + transferring |
| `creditWalletTopUp` | `lib/services/analytics.ts` (#40) | Reads current wallet balance before credit |
| `computeUsageSplit` callers | `lib/stripe/transfers.ts` | Reads vendor cut bps before split computation |

## Pattern

```ts
import { getDbFresh } from "@/lib/db/with-replica";

// In any money-critical service function:
const db = getDbFresh();
const { data: wallet } = await db
  .from("credit_wallets")
  .select("balance_cents")
  .eq("id", walletId)
  .single();

// ... then write
```

## Rules

1. All paths in the table above are **banned** from using `getDbReadOnly()`.
2. New paths that read-then-write money MUST be added to this table before the PR merges.
3. The reviewer-of-record signs off on this list at launch.
4. After adding a read replica, run `EXPLAIN (ANALYZE)` on these paths to confirm they hit primary.

## Non-money reads (replica eligible)

These paths are safe to use `getDbReadOnly()`:
- Dashboard analytics aggregates (non-financial)
- Marketplace browse / search
- Public affiliate profiles / leaderboard
- Reseller storefront listing pages
- Vendor analytics rollups (already aggregated)

## Adding a new money-critical path

Before merging any PR that introduces a read-then-write-money path:
1. Add the path to this table.
2. Confirm it uses `getDbFresh()` or `freshRequired: true`.
3. Add a test that asserts the DB call goes to primary (mock the replica).
