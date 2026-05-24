# Task #54 — Wave 9 scale invariants & operational seams

> **Before starting:** read [build_prompts/48-scale-resilience-foundation.md](build_prompts/48-scale-resilience-foundation.md), [build_prompts/49-solutions-abstraction.md](build_prompts/49-solutions-abstraction.md), [build_prompts/50-agency-client-deployments.md](build_prompts/50-agency-client-deployments.md), [build_prompts/51-outcome-metrics.md](build_prompts/51-outcome-metrics.md), `ENGINEERING.md` §5–11.
> **Definition of Done:** the cross-cutting seams the Wave 9 stack needs to **scale to 10M users / 1M agencies / 100M deployments / 1B+ events/day** are declared and stubbed in code. Most of these are **interface-first, implementation-light** — the goal is to ensure no future scaling decision requires rewriting service code or schema. Code touches one file per seam; future scaling lands behind that interface.

**Phase 6 — Wave 9 cross-cutting foundation. Depends on: #47, #48, #49 (sharding seam already added). Runs in parallel with / right after #50 + #51. BLOCKS launch but NOT #40–#44 implementation (they consume these seams as they're built).**

> **Why these seams are non-negotiable:** every single one of them is **cheap to add now**, **impossible to retrofit at scale**. The pattern: declare the interface, ship a single-tenant / single-region / single-cluster implementation, and let real scale pressure migrate the implementation behind the interface. Service code never knows the difference. The cost of skipping this task is a 6-month rewrite when traffic hits 10× plan.

---

## Sections to build

### 1. Search abstraction (Postgres now, external later)
- `lib/search/index.ts` exports a single interface:
  ```ts
  export interface SearchIndex<T> {
    search(query: string, filters: SearchFilters, opts: { cursor?: string; limit: number }): Promise<{ rows: T[]; nextCursor?: string }>;
    indexDocument(id: string, doc: T): Promise<void>;
    deleteDocument(id: string): Promise<void>;
    bulkReindex(rows: AsyncIterable<T>): Promise<void>;
  }
  ```
- Current impl: `lib/search/postgres/solutions.ts` — wraps the existing Postgres FTS + `solutions (status, solution_type, created_at DESC)` indexes (#49). Marketplace listing pages (#37) route through this interface, never raw queries.
- Future impl seam: `lib/search/algolia/solutions.ts` or `lib/search/meilisearch/solutions.ts` — drop-in replacement when active solutions exceed ~1M.
- **Indexing**: every `INSERT/UPDATE/DELETE` on `solutions` fires an after-commit trigger that enqueues a `search_reindex` job (via #48 queue). For Postgres impl, the job is a no-op (the table IS the index); the queue path exists so flipping to external search is a config change, not a schema change.
- **Index health check**: a `lib/search/health.ts` endpoint reports backlog size + last-indexed-ts; the admin dashboard (#36) surfaces it. If backlog > 10k, dashboard warns; if > 100k, an alert fires.
- Same pattern declared (interface-only, no impl yet) for: marketplace `agents` browse (#41), workflow templates browse (#42), agency directory (future). Don't write the agent/workflow impls now; the interface declared here ensures #41/#42 will use it from day 1.

### 2. Read-replica routing + money-critical primary reads
- `lib/db/with-region.ts` (stub) + `lib/db/with-replica.ts` (new):
  ```ts
  getDb({ region?: string; readOnly?: boolean; freshRequired?: boolean }): SupabaseClient;
  ```
- Rules:
  - `freshRequired: true` → primary, always. Use for: wallet balance reads in `recordUsage` (#40), settlement loops, dispute decisions, anything that determines money.
  - `readOnly: true, freshRequired: false` → replica eligible. Use for: dashboard reads, marketplace browse, public profile pages.
  - Default (no opts) → primary (safe default). Audit-friendly.
- Current impl: returns the single Supabase client for everything. Future: routes to a read replica for `readOnly: true`. **Service-layer code already uses the new helper from day 1**, so adding replicas later is a one-line config change.
- **Lint rule** (eslint custom rule, registered in this task): forbid direct `supabase.from(...)` imports in `lib/services/**` — must go through `getDb(...)`. Existing code migrated incrementally as services are touched.
- **Money-critical paths audit checklist** (file: `docs/money-critical-reads.md`): every code path that reads then writes money values MUST be flagged `freshRequired: true`. List of paths: `recordUsage`, `processPendingTransfers`, `handleInvoicePaid`, `handleChargeRefunded`, `handleDisputeClosed`, settlement jobs, credit-wallet top-up webhook. Reviewer-of-record signs off on this list at launch.

### 3. Region / data-residency seam
- `organizations.region text NOT NULL DEFAULT 'us-east-1'` — strings, not enum (future regions = config, not migration).
- `solution_deployments.region` denormalised from `client_org.region` at insert (immutable). Inherited by `usage_events.region` (#40), `deployment_metrics.region` (#51), `connector_accounts.region` (#43), `analytics_events.region` (#46 — add column if missing).
- All hot-table indexes prefix `(region, tenant_shard_id, …)` so a future router can `WHERE region = $1 AND tenant_shard_id = $2 AND ...` and scan exactly its shard. **Cost now: one extra column in each index, zero query cost** (Postgres skips the constant-true region predicate when only one region exists).
- **EU client routing**: when a client_org is created with `region='eu-west-1'`, all downstream rows inherit. Cross-region reads from the dashboard (an agency in US managing an EU client) are explicit + audited (logged as `cross_region_read`).
- Until a second region launches, the router is a pass-through. The schema is ready.

### 4. Tenant noisy-neighbor backpressure
- **Per-tx tenant trace**: every Server Action / API route opens its transaction with `SET LOCAL app.org_id = $1`. `pg_stat_statements` + a `tenant_query_stats` mview correlate runaway queries to specific orgs (admin dashboard #36 surfaces top tenants by total query time).
- **Per-role connection budget**: PgBouncer transaction-pooling on Supabase already in place; in `lib/db/with-replica.ts` declare per-role weights: vendor 30%, agency 30%, client 30%, admin/cron 10%. Enforced at the connection-pool layer (Supavisor pool config, not application code). Prevents one role from starving the others.
- **Auto-kill long-running tenant queries**: `pg_cron` job every minute scans `pg_stat_activity` for `app.org_id` set + `query_start > now() - interval '60 seconds'` + not in (admin, cron) → `pg_cancel_backend`. Writes to `audit_log` and notifies the org. Default threshold tunable per org tier (Enterprise gets 300s).
- **Per-org quotas** (extend #48 `org_quotas` with new keys):
  - `max_active_deployments` (default: 100, agencies: 1000, configurable per tier)
  - `max_clients` (per agency org, default 50, configurable)
  - `webhook_deliveries_per_min` (default 100)
  - `workflow_runs_per_min` (per #42)
  - `outcome_emits_per_sec_per_deployment` (default 100, per #51)
  - `connector_oauth_refreshes_per_min` (per #43)
  - Every new feature MUST declare a quota key + enforce via `enforceQuota`; default-deny continues.

### 5. Subdomain + custom domain SSL strategy
- **Decision (locked here, not deferred further):** **Cloudflare for SaaS** for production. Vercel's wildcard cert covers `*.platform.com`; Cloudflare for SaaS handles bring-your-own-domain (`portal.acme-agency.com`) via fallback origin + custom hostnames API.
- Why: Vercel custom domains can only attach one domain per project; at 100k+ custom domains this hits limits. Cloudflare for SaaS is purpose-built (used by Shopify, Webflow, etc.) — single product, billed per hostname.
- **Implementation seam (stub now, full later):**
  - `organizations.custom_domain text NULL UNIQUE` — agency optionally sets a custom domain. Validated (DNS A/CNAME points to `cf-saas.platform.com`).
  - `proxy.ts` accepts custom domains as the Host header → resolves to agency via `custom_domain` lookup → same rewrite logic as subdomain WL (`/_wl/<slug>`, `/_client/<slug>`).
  - Feature flag `CUSTOM_DOMAINS_ENABLED` default false — turn on when Cloudflare for SaaS is wired (a future ops task).
- **Subdomain enumeration prevention**: every new agency slug passes through the same reserved-list check as #29 (`www/api/admin/auth/app/dashboard/support/help/mail/email/ftp/ns1/ns2/staging/dev/test/prod/portal/clients/billing/legal`). Reserved list lives in `lib/reserved-slugs.ts` (single source of truth — `proxy.ts` imports from there).

### 6. Settlement batching invariants (Stripe transfer rate-limit guard)
- **One Stripe transfer per recipient per settlement period** (default: 1 day). Settlement job aggregates all unsettled `usage_events` for `(vendor_org_id OR agency_org_id, period_start, period_end)` into a single transfer with metadata pointing to the aggregate.
- **Why**: Stripe's API limit is ~100 req/sec sustained per account. At 1M agencies receiving daily transfers = 1M API calls/day; bursty if all settlements run at once. Batching: 1M agencies / 86400s = ~12 transfers/sec sustained, well within limits.
- **Schema**: `settlement_batches` table (`id`, `recipient_org_id`, `period_start`, `period_end`, `total_cents`, `stripe_transfer_id`, `status`, `event_count`). UNIQUE on `(recipient_org_id, period_start, period_end)` — re-running settlement is a no-op (idempotent).
- **Settlement job** (extends #40 §5): per-recipient job in #48 queue, picks up all `usage_events` with `settled_at IS NULL` in the window, sums shares, creates ONE transfer, marks events with the batch_id + settled_at in one transaction.
- **Audit invariant**: `Σ usage_events.share_cents settled in batch === settlement_batches.total_cents === stripe_transfer.amount`. Reconciliation (`lib/services/reconciliation.ts` extended) checks this nightly + flags drift.

### 7. OAuth refresh stampede mitigation (#43 hand-off)
- Google/Microsoft access tokens expire in ~1 hour. At 100M connector accounts where the majority were granted in business-hours bursts, refresh storms hit predictable peaks.
- **Pattern (declared here, implemented in #43)**: refresh tokens are refreshed **scheduled, not on-demand**. Each connector_account has a `next_refresh_at` set to `(token_expiry - 5min) + jitter(0..5min)`. A `connector-refresh-cron` (every minute) claims due rows via #48 `claim_jobs` SKIP LOCKED, refreshes in parallel (capped at 100 concurrent per worker), updates the next expiry.
- **Backpressure**: per-provider rate limit (Google: 1000 req/min/project default — needs OAuth project sharding strategy declared in #43). When throttled, exponential backoff + retry; tokens that fail to refresh 3 times in a row mark the connector `requires_reauth` and notify the client.
- **On-demand refresh (fallback only)**: if a runtime call (gateway/workflow) finds an expired token because the cron hadn't run, it refreshes inline once — but the inline path holds a per-account Redis lock to prevent thundering-herd (only one inline refresh per account at a time; others wait).

### 8. Hot wallet contention (#40 hand-off)
- A single agency operating thousands of deployments for one client all hitting the same `credit_wallets` row at runtime = serialised by row lock. At 1000 runs/sec on one client's wallet, latency degrades.
- **Pattern (declared here, implemented in #40)**: high-traffic wallets are **sharded** — `credit_wallets.shard_count smallint DEFAULT 1`. When `shard_count > 1`, the wallet logical balance is split across N rows (`credit_wallet_shards (wallet_id, shard_idx, balance_cents)`). Draw-down picks a shard via `(deployment_id_hash % shard_count)` + locks only that shard. Top-ups go to a fan-in shard (0); a rebalance cron periodically equalises.
- **Default `shard_count=1`** (most wallets never need sharding). Auto-promotion to `shard_count=8` triggered when a wallet records > 100 draw-downs/min for 5 minutes consecutive (cron). Manual promotion via admin tool.
- **Invariant**: `Σ shard balances === logical balance`. Reconciliation checks nightly.

### 9. Idempotency dedupe table (separate from financial events)
- `usage_events` (#40) and `deployment_metrics` (#51) both use partial UNIQUE indexes on idempotency keys. At 1B+ events/day, these indexes become hundreds of GB — bloats the WAL + slows inserts.
- **Pattern**: move idempotency dedupe to a **separate sharded table** `idempotency_keys_v2` (`scope`, `key`, `created_at`) with **TTL via partitioning** (drop partitions > 7 days old — idempotency replays beyond a week are extremely rare and explicit feature, not a default behavior).
- **Replaces** per-event-table unique indexes with a single dedupe table that all writers consult. Implementation: `recordUsage` first inserts into `idempotency_keys_v2` with `ON CONFLICT DO NOTHING`; if `rowcount=0` (already exists), short-circuit return `deduped=true` without touching `usage_events`. Same pattern for `emitMetric`.
- **Cost**: one extra INSERT per write, but ~10× cheaper index footprint long-term. **Net win** at >100M events/day.
- **Hand-off**: this pattern is declared here; #40 and #51 implementations cite this section and use the shared table.

### 10. Reserved-slug + identifier registry
- Single file `lib/reserved-slugs.ts` exports the deny-list used by:
  - Agency subdomain creation (#50)
  - Reseller subdomain creation (#29 — migrate to import from here)
  - User vanity slugs (#25 affiliates, #44 templates)
  - Custom domain validation (#54 §5)
- List includes: subdomain operational names (`www/api/admin/...` from #29), reserved business names (`platform/admin/support/billing/legal/security/abuse/postmaster/hostmaster/webmaster`), per-NIST common confusables, and a homoglyph-normalised lookup (reuses #29 `wl-brand.ts` normalisation function).
- Adding a new reserved name = one line edit; impossible to forget a surface.

### 11. Cold storage seam (declared for #46/#51, stub now)
- `lib/cold-storage/index.ts` exports:
  ```ts
  export interface ColdStorageRouter {
    queryRange(table: string, deploymentOrEntityId: string, from: Date, to: Date): Promise<{ inline: any[] } | { jobId: string; estimatedReadyAt: Date }>;
  }
  ```
- Current impl: always returns `inline` from the hot table.
- Future impl: when range is > 24 months ago, exports parquet from S3 → returns jobId; dashboards poll for completion.
- Dashboards (#52/#53/#36) MUST call through this router for any historical query. Direct table queries on cold ranges are forbidden by the lint rule registered in §2.

### 12. ENGINEERING.md updates
Add a new §12 "Wave 9 scale invariants" referencing each section above. Future PRs that touch hot tables / new resources / new search surfaces / new event tables MUST cite which invariants they satisfy. Reviewer checklist.

---

## Acceptance criteria
- [ ] `lib/search/index.ts` interface + Postgres impl for solutions; marketplace routes go through it; eslint rule blocks direct `solutions` table reads from page code.
- [ ] `lib/db/with-region.ts` + `lib/db/with-replica.ts` helpers exist; `freshRequired: true` is the default for money-critical paths; lint rule blocks raw `supabase.from(...)` in `lib/services/**`.
- [ ] `organizations.region` + downstream denormalised `region` columns; all hot-table composite indexes prefix `(region, tenant_shard_id, ...)`.
- [ ] `SET LOCAL app.org_id` instrumented in every Server Action transaction; `pg_cron` long-query auto-kill registered; `tenant_query_stats` mview exists.
- [ ] `org_quotas` extended with the new keys; `enforceQuota` used by every new resource creation path declared in #49-#53.
- [ ] Reserved-slugs single-source-of-truth file; #29 reseller proxy migrated to import from it.
- [ ] `settlement_batches` table created with UNIQUE constraint; #40 settlement worker referenced as the consumer.
- [ ] `idempotency_keys_v2` table + TTL partition rotation; pattern documented for #40/#51 consumption.
- [ ] `lib/cold-storage/index.ts` stub returns inline always; lint rule blocks raw queries for ranges > 24mo.
- [ ] `CUSTOM_DOMAINS_ENABLED` feature flag wired; `organizations.custom_domain` column added; proxy can rewrite based on Host (stub path for now).
- [ ] ENGINEERING.md §12 added; future-PR checklist documented.
- [ ] k6 smoke harness from #48 extended with: 1M-org browse, 100k-client agency dashboard, 1B-emit/day metric ingest spike (1k/sec sustained). p95/p99 thresholds documented.
- [ ] CLAUDE.md "Phase 6 Wave 9" Progress section adds #54 with link.
