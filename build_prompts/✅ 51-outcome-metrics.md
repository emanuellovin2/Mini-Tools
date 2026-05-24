# Task #51 — Outcome metrics seam (deployment ROI proof, no billing)

> **Before starting:** read [build_prompts/50-agency-client-deployments.md](build_prompts/50-agency-client-deployments.md), [build_prompts/46-engagement-analytics-events.md](build_prompts/46-engagement-analytics-events.md), [lib/services/analytics.ts](lib/services/analytics.ts), [supabase/functions/analytics-rollup-cron/](supabase/functions/analytics-rollup-cron/).
> **Definition of Done:** a generic time-series surface (`deployment_metrics`) where any agent/workflow can emit business KPIs (leads, meetings booked, tasks completed, hours saved, $ saved). Agency dashboard (#52) and client portal (#53) read this to prove ROI. **No billing logic** — purely reporting. Foundation for an eventual success-fee model in a future task, without committing to attribution headaches now.

**Phase 6 — Wave 9 foundation. Depends on: #50 (deployments), #48 (jobs + partition conventions). Parallel-able with #40-#44. Optional but high-leverage — the difference between "we run agents" and "we prove $50k of value per client per month."**

> **Why now:** the metrics seam is cheap as a column-by-column addition before #41/#42 ship (their emit code adds one line per metric). Retrofitting after agents/workflows are live means rewriting every solution's instrumentation. The biggest moat agencies have vs DIY OpenAI is proving ROI — without this, agencies churn the moment the SMB's CFO asks "what does this cost vs deliver?"

> **What this is NOT:** a success-fee billing engine. Outcome attribution for *money* is a legal/dispute nightmare (see CLAUDE.md analysis). Outcome attribution for *reporting* is just an append-only counter. We ship the cheap, valuable half now and defer the contested half to data + a future task.

---

## Sections to build

### 1. `deployment_metrics` append-only table (**daily partition**, not monthly)
```
id uuid pk
deployment_id uuid FK solution_deployments(id) ON DELETE CASCADE
metric_key text NOT NULL          -- e.g. 'leads.qualified', 'meetings.booked', 'tasks.completed', 'usd.saved', 'hours.saved'
metric_value numeric(20,4) NOT NULL  -- numeric to support both counts and money/time decimals
metric_unit text NOT NULL         -- 'count' | 'usd' | 'hours' | 'minutes' | 'percent' | freeform — emit-time descriptor
dimensions jsonb NOT NULL DEFAULT '{}'  -- arbitrary slice keys: { source: 'linkedin', campaign: 'q3', persona: 'cto' } — bounded to 16 keys, values must be strings <= 64 chars (CHECK)
idempotency_key text NULL         -- (deployment_id, metric_key, idempotency_key) UNIQUE when set — same outcome reported twice = one row
emitted_at timestamptz NOT NULL   -- when the outcome happened (caller-provided)
created_at timestamptz NOT NULL DEFAULT now()  -- partition key
```
- **Partition `BY RANGE (created_at)` daily** from day one. **Why daily, not monthly:** at 100M deployments × 10 emits/day = 1B rows/day = 30B rows/monthly partition — past Postgres' healthy partition size (~100M rows for index scans to stay fast). Daily partitions keep each one in the 1B range; the rollup cron operates on one partition at a time (cheap drop after rollup). Monthly partitions stay only on low-volume tables.
- **Append-only**: no UPDATE/DELETE policy; corrections happen by emitting a negative-value compensation row with same `metric_key` (audit-clean; mirrors accounting).
- **Retention: 90 days raw**, then aggregated into `deployment_metrics_rollup` (daily by `(deployment_id, metric_key, dimensions_hash)` summing values). The rollup table is forever (with secondary tier after 24 months: cold-storage seam, see §3b). The raw table sheds partitions older than 90 days via `partition-rotation-cron` (#48). Why shorter than financial tables: outcome metrics aren't a financial record — they're a reporting signal. Granular history beyond 90d lives in the rollup, not raw.
- **Indexes** (each partition inherits): `(deployment_id, metric_key, created_at DESC)`, `(deployment_id, emitted_at DESC)`. Partial unique on `(deployment_id, metric_key, idempotency_key) WHERE idempotency_key IS NOT NULL`.
- **Sharding seam**: `tenant_shard_id smallint NOT NULL DEFAULT 0` indexed as first column of every composite (same pattern as #49/#50). At 1B emits/day, a future shard router can split by `(tenant_shard_id, deployment_id)` across clusters without rewriting any service code.

### 2. `emitMetric` — the only write path (**async-default at declared high volume**)
`lib/services/outcomes.ts`:
```ts
emitMetric({ deploymentId, key, value, unit, dimensions?, idempotencyKey?, emittedAt? }): { ok, deduped, queued }
```
- Called from #41 gateway result-handler, #42 workflow step output, agency-built custom emitters, or a webhook endpoint `POST /api/deployments/[id]/metrics` that vendors/workflows hit with a deployment-scoped API key (reuses partner API key infra from #39).
- Idempotency: if the same `(deployment_id, metric_key, idempotency_key)` already exists, no-op return `deduped=true`. Critical for at-least-once delivery from workflow runs.
- Validation: `metric_key` matches `^[a-z][a-z0-9._]*$` (lowercased, dot-namespaced). Reject `dimensions` with > 16 keys or any value > 64 chars or > 8 distinct dimension keys per metric across one deployment's history (registered at first emit; subsequent emits must use the same dimension keys — keeps the rollup queryable).
- **Cardinality budget per `(deployment_id, metric_key)`**: max 1000 distinct dimension-value combinations rolled per day. Beyond that, the emit succeeds (raw table accepts it) but rollup marks the metric as `cardinality_overflow=true` and stops aggregating dimensional slices for that day (totals still computed). Vendor + agency get a notification (#39) advising to drop high-cardinality dimensions or split the metric. Prevents one rogue `request_id` dimension from exploding the rollup table.
- **Async-default at declared high volume**: each `solutions.runtime_config.outcome_metrics[]` entry declares a `volume_class: 'low' | 'medium' | 'high'`. `low` = sync direct insert (default). `medium` = sync but coalesced in caller-side buffer (1s window, max 100 emits). `high` = enqueued via `lib/jobs/queue.ts` with type `outcome_emit_batch`, batch-inserted in 1k-row chunks by a dedicated worker. Vendor publishing a metric without declaring volume_class defaults to `medium`. **Why this matters at scale:** a workflow with 1000 step-level emits per run × 10k runs/min = 10M sync inserts/min ≈ Postgres connection pool starvation. Async batching turns that into ~10k inserts/sec on one worker.
- **Backpressure**: the queue ingest rate is per-deployment rate-limited (via `lib/quotas/enforce.ts` from #48 — new quota key `outcome_emit_rps`, default 100/sec per deployment, configurable per org tier). Exceeded → emit returns `queued=false, throttled=true`; caller's responsibility to batch.

### 3. Rollup cron (incremental, watermark-driven — not full-day rescan)
- `outcomes-rollup-cron` Edge Function, every 15 minutes (not daily), enqueues one `jobs` row per `(partition_date, shard_range)` that has un-rolled-up data since the last watermark.
- `deployment_metrics_rollup` table includes a `rollup_watermark timestamptz` per `(deployment_id, metric_key, dimensions_hash, date)` row — handler reads metrics since the watermark, sums in, advances the watermark atomically. Re-running on already-rolled data is a no-op (watermark unchanged). **At 1B emits/day, a full-day rescan once per day = 1B-row scan; an incremental every 15min = ~10M-row scans (100× cheaper)**.
- Handler groups by `(deployment_id, metric_key, dimensions_hash, date)`, sums into `deployment_metrics_rollup`. Idempotent (uses `INSERT ... ON CONFLICT DO UPDATE` keyed on the rollup unique constraint).
- Dashboards (#52, #53) **always** read the rollup, never raw — same pattern as #46 `analytics_daily`.

### 3b. Cold storage seam for rollups beyond 24 months
The rollup table grows linearly forever. Past 24 months, rows are exported nightly to S3 parquet (one file per `(deployment_id, year-month)`) and dropped from the hot table. The dashboards query an `outcomes_archive_router(deployment_id, range)` function that returns hot-table rows for ranges ≤ 24mo or queues an async archive query for older ranges (returns a job_id; UI shows "preparing export"). **Declared, not built now** — at year 1 we won't have 24mo of data; the seam ensures we don't paint ourselves into a corner. The archive function is a stub in this task that always reads hot table; full S3 path lands in a future ops task.

### 4. Read API — agency, client, vendor (different shapes per role)
`lib/services/outcomes.ts`:
- `getDeploymentOutcomes(deploymentId, { since, until, metricKeys?, dimensions? })` — returns time-series for one deployment. **RLS-gated**: client org member or operating agency org member only.
- `getAgencyOutcomeSummary(agencyOrgId, { since, until })` — aggregates across all the agency's active deployments: top metrics by total value, trend, per-client breakdown. Used by #52.
- `getClientOutcomeSummary(clientOrgId, { since, until })` — same shape, scoped to the client. Used by #53 client portal.
- `getSolutionOutcomeBenchmarks(solutionId)` — *anonymous* aggregates (median, p25/p75) across all deployments of this solution, used by the marketplace listing to show vendors "this agent typically delivers X meetings/month." Strips per-deployment + per-org identifiers; minimum 5 deployments required to return data (k-anonymity guard).

### 5. Vendor instrumentation contract (the convention)
- Vendors declare metric schemas on their solution at publish time: `solutions.runtime_config.outcome_metrics: [{ key, unit, description, expected_dimensions: [] }]`. Validation rejects emits that don't match a declared schema (after the first emit, locking the schema — schema-as-code).
- Reserved namespaces:
  - `lead.*` — counts of leads in pipeline stages
  - `meeting.*` — meetings booked/held/no-showed
  - `task.*` — tasks/runs/jobs completed
  - `time.*` — hours/minutes saved or spent
  - `revenue.*` — $ generated (vendor must declare unit='usd' and currency — multi-currency seam reuses #40's pattern)
  - `cost.*` — $ saved
  - `quality.*` — 0–100 scores
- Custom keys live under `custom.<vendor_slug>.<key>` — surfaces in dashboards but doesn't aggregate to cross-solution benchmarks.

### 6. Privacy guardrails
- `dimensions` jsonb CHECK rejects keys/values that look like emails, phone numbers, or 16-digit card-pattern strings (regex check at insert + a CI lint test with a deny-corpus). Outcome metrics are *aggregate KPIs*, not PII transport.
- Vendors emit through gateway/workflow (which run server-side, no client-supplied free text). Direct webhook emits require an API key scoped to the deployment and rate-limited 10/sec per deployment.
- RLS: vendor reads only aggregates via `getSolutionOutcomeBenchmarks`, never per-deployment values. Agency sees its clients' values. Client sees own. Admin sees all.

---

## Acceptance criteria
- [ ] `deployment_metrics` created, monthly-partitioned, append-only, indexed for the three main query shapes.
- [ ] `deployment_metrics_rollup` created; daily rollup cron enqueues one job per partition window via `jobs` queue (#48 pattern).
- [ ] `emitMetric` is idempotent on `(deployment_id, metric_key, idempotency_key)`; double-emit returns `deduped=true`, never duplicates rows.
- [ ] `metric_key` namespace validated; reserved namespaces documented in SPEC.md addendum.
- [ ] Solutions declare `outcome_metrics` schema at publish; unknown-key emits rejected after first emit (schema locked).
- [ ] Dimension PII guard rejects emails/phone/PAN at insert + has a regression test corpus.
- [ ] RLS: client/agency/vendor/admin boundaries proven by `outcomes-rls.test.ts` (12+ cases).
- [ ] `getSolutionOutcomeBenchmarks` enforces k≥5 deployments before returning data; below threshold returns `{ insufficient_data: true }`.
- [ ] No PII in `deployment_metrics` (lint + runtime CHECK).
- [ ] **Daily partitioning** active on raw `deployment_metrics`; partition-rotation-cron creates next-day partitions ahead of time + detaches >90d.
- [ ] **Cardinality budget** enforced — exceeding it sets `cardinality_overflow=true` on the rollup row; dimensional aggregation pauses for that day; vendor/agency notified.
- [ ] **`volume_class`** on each declared metric ('low'|'medium'|'high'); high routes through #48 jobs queue + batch worker; e2e test proves at 10k emits/sec throughput.
- [ ] **Incremental rollup with watermark** — replay test inserts same data twice, asserts rollup is unchanged.
- [ ] **`outcomes_archive_router` stub** in place returning hot-table reads; documented for future S3 hand-off.
- [ ] `tenant_shard_id` column + first-of-composite indexing.
- [ ] CLAUDE.md "Wave 9" section adds outcome metrics one-liner; SPEC.md gains §15 "Outcome metrics" with reserved namespaces table.
