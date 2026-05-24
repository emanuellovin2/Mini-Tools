# Task #48 — Scale & resilience foundation (the "10M users" hardening)

> **Before starting:** read `ENGINEERING.md` in full, [build_prompts/47-organizations-multiseat.md](build_prompts/47-organizations-multiseat.md), [build_prompts/46-engagement-analytics-events.md](build_prompts/46-engagement-analytics-events.md), [build_prompts/40-usage-metering-billing.md](build_prompts/40-usage-metering-billing.md). Read [lib/services/reconciliation.ts](lib/services/reconciliation.ts) (existing reconciliation pattern) and [lib/utils/rate-limit.ts](lib/utils/rate-limit.ts).
> **Definition of Done:** the platform survives a 100×→10 000× traffic jump without re-architecting. This task ships the **cross-cutting infrastructure** every later task depends on but none of them owns alone: a durable async job queue, per-org quotas, statement-timeout middleware, the partition/retention/RLS-perf conventions document, the outbound-webhook delivery worker, and a load-test smoke harness. **All of these are easy now and brutally expensive once live data exists.**

**Phase 6 — Wave 9. Depends on: #47 (org_id, `is_org_member`). BLOCKS #46, #40–#44 (they all consume these primitives from day 1). Runs RIGHT AFTER #47.**

---

## Why one task, not spread

Each piece below is foundational on its own — a single missing convention (no partition strategy, no durable jobs, no quotas) compounds across every kitchen and every dashboard. Bundling forces a single coherent decision and one migration window; spreading means each task re-invents these patterns inconsistently. **The Wave 9 specs already assume these primitives exist** (#46 says "partition-friendly", #45 says "background job", #40 says "settlement cron") — this task is where they actually become real.

---

## Sections to build

### 1. Durable async job queue (`jobs` table + tick-driven worker)
Today every async path is "Edge Function cron, fire-and-forget" — fine at small scale, **wrong** at scale: a timeout mid-fan-out (erasure across kitchens, export ZIP build, settlement transfers, rollup) leaves orphan state and silently loses work. Replace with a single durable queue, reusing the **exact tick pattern** from #42's workflow executor (it's already proven):

```sql
create table jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,                  -- 'erasure'|'export'|'rollup'|'settlement'|'webhook_delivery'|...
  payload jsonb not null,
  status text not null default 'queued', -- queued|running|succeeded|failed|dead
  attempts int not null default 0,
  max_attempts int not null default 5,
  next_run_at timestamptz not null default now(),
  locked_by text,                       -- worker id for atomic claim
  locked_until timestamptz,             -- lease so a dead worker releases
  last_error text,
  result jsonb,
  org_id uuid references organizations(id),  -- for RLS + quotas (#47)
  idempotency_key text,                 -- UNIQUE per (type, idempotency_key)
  created_at timestamptz default now(),
  finished_at timestamptz
);
create unique index on jobs (type, idempotency_key) where idempotency_key is not null;
create index on jobs (status, next_run_at) where status in ('queued','running');
```

- A `jobs-worker-cron` (Edge Function, ~every minute) atomically claims rows via `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT N) RETURNING *` (the same atomic-claim shape used for webhooks), runs the handler, sets `next_run_at` for retry on failure (exponential backoff), and writes `result` on success.
- **Handler registry** (`lib/jobs/handlers.ts`): each job type registers `(payload, ctx) => Promise<result>`. Long work splits itself into multiple jobs (e.g. erasure enqueues one job per registered eraser; export builds the ZIP in chunks).
- All previously-fire-and-forget paths migrate to this: erasure fan-out (#45), data export (#39), analytics rollup (#46), usage settlement (#40), reconciliation (#12), outbound webhook delivery (§4 below). One source of truth for async durability.

### 2. Per-org quotas (`org_quotas`) + soft/hard caps
Without quotas, one bad actor — accidentally or maliciously — can create 10M offers, 10M api_keys, or 10M workflows and degrade the whole platform. Define **structural quotas from day 1**, even if defaults are very generous:

```sql
create table org_quotas (
  org_id uuid primary key references organizations(id),
  -- count caps (per resource)
  max_offers int default 1000,
  max_api_keys int default 50,
  max_workflows int default 500,
  max_affiliate_links int default 10000,
  max_connectors int default 100,
  max_webhook_endpoints int default 25,
  -- rate caps (per-second, enforced by Upstash + check)
  api_rps int default 50,
  events_rps int default 200,            -- /api/events beacon
  workflow_runs_rps int default 20,
  -- size caps
  max_workflow_steps int default 50,
  max_partner_clients int default 100000,
  updated_at timestamptz default now()
);
```

- `enforceQuota(orgId, resource)` helper called from every creation server action / API route. Soft-block with clear error (`QUOTA_EXCEEDED`) — never silently fail.
- Admin UI (#36 admin v2) reads + sets per-org overrides (audit-logged).
- Rate-limit middleware reads `org_quotas.*_rps` for keyed limiting per org (already on Upstash; wire the lookup).
- **Default-deny stance for new resource types**: any future build that adds a creatable resource MUST add a quota row + enforcement — codified in `ENGINEERING.md` (see §5 below).

### 3. `statement_timeout` middleware (30s default) + slow-query log
A single slow query can pin a Postgres connection, starve everyone else, and cascade into timeouts everywhere. Wire this once, in the request boundary:

- Every API route + server action sets `SET LOCAL statement_timeout = '30s'` at the start of its transaction (helper in `lib/db/with-timeout.ts`). Hot paths (marketplace listing, search) use a tighter 5s; cron handlers use 5m.
- Slow queries (>2s) log a structured warning via the existing `logger.ts`; admin v2 (#36) surfaces a "Slow query feed" panel.
- **Webhook endpoints unchanged** — they already need to ack fast (Stripe expects <20s) and use the atomic-claim pattern; keep their explicit budgets.

### 4. Outbound webhook delivery worker (replaces in-handler fan-out)
Today the spec for `vendor_webhooks` (#39 §5) says the dispatcher "queues a POST" — that queue must be **the `jobs` table**, not in-process. At scale, 10K partners subscribed to `v1.subscription.created` × every event = 10K outbound HTTP attempts per event; doing them inline blows the request budget and the connection pool.

- Webhook handler enqueues one `jobs` row per `(subscription, endpoint)` with `type='webhook_delivery'`.
- The job handler does the HTTP POST with HMAC sig, captures status + body excerpt to `vendor_webhook_deliveries`, retries with exponential backoff on 5xx/timeout (max 5), marks `dead` after exhausting.
- Per-endpoint concurrency cap (e.g. 5 in-flight) so one slow partner can't starve the worker pool.
- Admin DLQ view (in #36): list `status='dead'` deliveries, manual replay button (re-enqueue).
- This same pattern is the only correct one for **partner outbound webhooks via api_keys** (#39 §6) — reuse it.

### 5. Conventions document — `ENGINEERING.md` gets four new sections
Conventions only matter if every future task follows them. Extend `ENGINEERING.md`:

**5.1 Partitioning policy for hot append-only tables.** The list of partitioned tables is fixed from day 1: `usage_events` (#40), `analytics_events` (#46), `analytics_daily` (#46 — partition or roll), `audit_log` (#47), `run_steps` (#42), `vendor_webhook_deliveries` (#39), `credit_transactions` (#40), `notifications` (#39), `jobs` (this task — finished rows archive). Convention: **declarative monthly partition by `created_at`** (`PARTITION BY RANGE`), partition rotation handled by `partition-rotation-cron` (creates next month's partition, attaches it, optionally detaches partitions older than the retention window). Every spec that creates a hot table MUST declare its `PARTITION BY` + retention window in the migration comment. Reference example in this task's migration.

**5.2 Retention policy table.** A single canonical table (in `ENGINEERING.md` + as comments on each table): how long raw rows live before being rolled up or archived. Examples: `analytics_events` raw=90d (then summarized in `analytics_daily`); `audit_log` raw=18mo then S3 archive; `run_steps` raw=180d; `vendor_webhook_deliveries` raw=60d; `jobs` succeeded=14d, failed=90d; `notifications` raw=180d; `credit_transactions` and `usage_events` **never** raw-purged (financial — keep + partition forever).

**5.3 RLS performance rules (load-bearing).**
- Every `is_org_member(org_id, min_role)` (and any RLS helper that hits a lookup table) MUST be `STABLE SECURITY DEFINER` so the planner caches per query.
- `org_members` MUST have a composite index `(user_id, org_id) INCLUDE (role)` so the helper is one indexed lookup.
- Policies SHOULD scope by `org_id` early in the policy expression so partition-pruning + index lookup happen before the helper runs. Pattern: `org_id = any(my_org_ids())` where `my_org_ids()` is a `STABLE` set-returning function the planner inlines once.
- Every RLS-protected hot table MUST have an `org_id` index (already implied by partition strategy + per-table index list, but call it out).
- Forbidden: `auth.uid()` in subqueries used in policies that run per-row on huge tables — always wrap in the cached helper.

**5.4 Migration safety pattern.** No `ALTER TABLE ADD COLUMN NOT NULL DEFAULT <expr>` on hot tables (rewrites every row, holds AccessExclusiveLock). No `CREATE INDEX` (use `CREATE INDEX CONCURRENTLY`). No `ALTER TABLE ... ADD CONSTRAINT` without `NOT VALID` then `VALIDATE CONSTRAINT`. No `ALTER TYPE ... ADD VALUE` mid-transaction. The convention:
  1. Add nullable column with no default — instant.
  2. Backfill in batches (`UPDATE ... WHERE id IN (... LIMIT 10000)` looped, ideally as a `jobs` row of type `backfill`).
  3. Add `NOT NULL` + CHECK once backfill is complete.

  This MUST be the documented pattern for #47's org backfill (the most consequential migration in the codebase).

### 6. Edge caching policy (doc + a few code touches)
At 10M users browsing marketplace, every page render hitting Postgres = catastrophic. Edge caching is mostly architectural, not schema:

- **Marketplace listing** (`/marketplace`): Next.js ISR with revalidate=60s + on-demand revalidation when an app is approved/featured/edited.
- **App detail** (`/app/[slug]`): ISR revalidate=300s + on-demand revalidation on review/screenshot/price change.
- **Reseller storefronts** (`/r/<slug>/<offer>`, `/_wl/<slug>/<offer>`): ISR revalidate=300s + invalidate on offer-status change.
- **Public affiliate leaderboard / profiles**: ISR revalidate=900s.
- **Authenticated dashboards**: no edge cache, but use React `cache()` for per-request memoization.

Document this in `ENGINEERING.md` + add a thin `lib/cache/revalidate.ts` that named-tags revalidation calls so any service-layer mutation can revalidate the right tag.

### 7. Load-test smoke harness (so we KNOW, not assume)
A small **checked-in** k6 script (`scripts/loadtest/smoke.js`) covering the four scariest paths:
- subscribe webhook + transfer (money path),
- `recordUsage` concurrent draw-down (the #40 lock test, run at 200 concurrent),
- `/api/events` beacon at 1k rps,
- marketplace listing read at 5k rps.

Runs against a seeded local stack. CI runs nightly (later). Goal isn't to prove "we handle 10M" today — it's to **own a baseline number** so any regression is immediately visible. Document expected p95/p99 in `ENGINEERING.md`.

### 8. Stripe API resilience
Settlement (#40), connect onboarding, and transfer-batches at scale will hit Stripe rate limits (default ~100 rps). Add `lib/stripe/with-retry.ts` (shared wrapper): retries on 429 + 5xx with exponential backoff + jitter, max 5 attempts, **idempotent calls only** (transfers, refunds, charges always have idempotency keys per ENGINEERING.md). Every Stripe SDK call from cron paths goes through this wrapper.

### 9. Backup + PITR verification
A documented quarterly drill (`docs/runbooks/restore-drill.md`): restore the latest Supabase PITR snapshot to a sandbox project, run a smoke checklist (boot, migrations apply, RLS holds, one buyer can read their subscriptions). Without this drill, "we have backups" is a belief, not a fact. The drill itself is later — this task just lands the runbook + the schedule.

---

## Data layer additions
```ts
// lib/jobs/queue.ts (new)
enqueueJob(type, payload, opts?: { idempotencyKey, orgId, runAt }): { jobId }
claimJobs(workerId, limit): Job[]                  // SKIP LOCKED, sets locked_until
completeJob(jobId, result): void
failJob(jobId, error, retryIn?): void              // marks dead after max_attempts
// lib/jobs/handlers.ts — registry: handlers[type] = (payload, ctx) => result

// lib/quotas/enforce.ts (new)
enforceQuota(orgId, resource): void                // throws QUOTA_EXCEEDED
getQuotaUsage(orgId): Record<Resource, { used, limit }>

// lib/db/with-timeout.ts (new)
withStatementTimeout(ms, fn): Promise<T>           // SET LOCAL statement_timeout

// lib/stripe/with-retry.ts (new)
withStripeRetry(fn): Promise<T>                    // 429/5xx backoff

// lib/cache/revalidate.ts (new)
revalidateMarketplace() / revalidateApp(slug) / revalidateStorefront(slug, offer) / ...
```

## Acceptance criteria
- [ ] `jobs` table + worker cron runs; a job that throws is retried with backoff, exhausted = `dead`, dead jobs replayable from admin.
- [ ] At least three existing paths migrated to `jobs`: erasure (#45 stub OK), export (#39 stub OK), webhook delivery (#39 §5).
- [ ] `org_quotas` enforced on offer/api_key/workflow/affiliate_link/connector/webhook_endpoint creation; clear `QUOTA_EXCEEDED` error; admin can override per-org with audit log.
- [ ] `statement_timeout` set on every API route + server action (helper enforced); slow-query log fires above 2s; webhook routes exempt.
- [ ] `is_org_member` is `STABLE SECURITY DEFINER`; `org_members` has the composite index; an `EXPLAIN ANALYZE` on a hot RLS-protected query shows index lookup, not seq scan.
- [ ] All hot tables (`usage_events`, `analytics_events`, `audit_log`, `run_steps`, `vendor_webhook_deliveries`, `credit_transactions`, `notifications`, `jobs`) declare `PARTITION BY RANGE (created_at)` monthly + retention; `partition-rotation-cron` creates next-month + detaches expired.
- [ ] `ENGINEERING.md` extended with: partitioning policy, retention table, RLS perf rules, migration safety pattern, edge caching policy, expected p95/p99 baselines.
- [ ] k6 smoke harness checked in; running it locally produces a results JSON + baseline numbers in the README.
- [ ] `lib/stripe/with-retry.ts` wraps every cron-path Stripe call; a forced 429 in a test does NOT lose the transfer.
- [ ] `docs/runbooks/restore-drill.md` exists with quarterly schedule.
- [ ] Tests: jobs atomic claim under concurrency (no double-execution), quota enforcement, statement_timeout actually fires, RLS perf does not regress on the hot tables (EXPLAIN baseline check).
