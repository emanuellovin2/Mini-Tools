# [PLATFORM] — Engineering Principles

The goal: a correct, maintainable foundation with clean boundaries — not premature scaling infrastructure. The chosen stack scales to thousands of users on its own. Build it right, not big.

## Money & payments (most critical)
- Store all money as **integer cents** (`9900`), never floats. Store percentages as **basis points** (`2000` = 20%), never floats.
- Architecture is **Separate Charges & Transfers** (SPEC §11), not destination charges: buyer is charged on the platform account; vendor (and Phase-2 reseller) shares move via per-recipient **transfers** on `invoice.paid`. This is required so one charge can fund multiple recipients and so reversals are precise.
- Attach **idempotency keys** to every Stripe write (subscriptions, transfers, invoices); a retry must never double-charge or double-transfer.
- **Webhook handlers must be idempotent.** Stripe redelivers and does **not** guarantee ordering. Record every `event.id` in `webhook_events`, process once, and write handlers so an out-of-order or duplicate event is safe (e.g. `subscription.updated` may arrive before `created`).
- **Verify the Stripe webhook signature** on every webhook **before** acting. In Next.js App Router this requires the **raw body** (`await req.text()` — never `req.json()` first), with `export const runtime = 'nodejs'` and body parsing disabled.
- The **database is the source of truth for entitlements/access**, reconciled from Stripe events — never grant access off an unconfirmed client redirect. Map Stripe status → access via the SPEC §8 state machine, in **one** shared function.
- **Refunds/disputes reverse money:** reverse the matching transfer(s) on `charge.refunded` / `charge.dispute.*`; handle negative balances. Compute trailing revenue **net of** refunds/chargebacks. Refunds count toward the **calendar month they OCCUR** (cash-basis, SPEC §3) — never re-tier a closed `vendor_billing` period.
- The flat tier fee ($49/$99) is a **separate monthly Stripe invoice to the vendor**, idempotent per `vendor_billing` period — never an `application_fee`.
- All money moves via Stripe Connect transfers; the platform never holds or moves funds manually.

## Security
- **RLS is the real enforcement layer.** Assume the app layer can be bypassed; every table has policies that hold on their own. **Write RLS tests** (cross-vendor read denied, role escalation denied, buyer-can't-read-others).
- **Privilege-escalation guard:** the `profiles` UPDATE policy must enforce that `role` cannot change (`WITH CHECK` new role = old role). Roles and Stripe/Connect columns are written only via the service role.
- **Anti-poaching data boundary:** vendors must have **no path** to `subscriptions.buyer_id` or any buyer PII. Expose vendor stats only through the `vendor_subscription_stats` view/RPC (anon id + status + revenue). Audit every new vendor-facing query against this rule.
- **Validate every API input with Zod** at the boundary. Never trust the client.
- The **service role key is server-only**. Never ship it to the browser; never use it to skip RLS casually.
- **Validate env vars at boot** with a Zod schema (fail fast if a key is missing/malformed). Secrets live in env vars only; never commit them.
- **Rate-limit** auth endpoints and the public `/api/verify`.
- **Safe file upload** (vendor logos): allow only `png/jpg/webp` (reject SVG — inline SVG is an XSS vector), cap size, set Storage bucket RLS, serve from a dedicated bucket. **Validate magic bytes server-side**, not just `Content-Type` (the header is client-controlled and trivially spoofed).
- **CSRF:** Next.js Server Actions ship with built-in CSRF tokens — use them for form-based mutations. API routes that mutate state must either require a Supabase session cookie (same-site, `httpOnly`) or check `Origin`/`Referer` against `NEXT_PUBLIC_APP_URL`. Webhook endpoints are exempt — signature verification IS the auth.
- Never expose buyer email or card data to vendors (anonymous token model, SPEC §6).
- **JWT:** RS256 with a `kid` header and a public **JWKS** endpoint so keys can rotate without breaking vendors. Tokens carry `iss`/`aud`/`jti`/`exp` (≤5 min); verify all of them plus a small `clockTolerance`.

## Architecture & maintainability
- **Strict TypeScript** (`strict: true`). No `any` without a written reason.
- **Generate types from the Supabase schema** and treat them as the single source of truth — no hand-duplicated DB types.
- **Centralize data access** in a service/repository layer (`lib/services/*`). Raw Supabase queries do not belong inside React components. Stripe access lives in `lib/stripe/*`, token logic in `lib/auth/*`.
- **DB transactions for multi-table writes.** Any path that writes to ≥2 tables (subscribe flow, webhook handlers, refund handling, monthly cron) MUST run inside a single transaction — Supabase RPC (Postgres function) or an explicit `BEGIN/COMMIT`. Half-written state (e.g. `subscriptions` row inserted but `audit_log` row not, or transfer created but webhook_events not marked processed) is the #1 source of silent billing bugs.
- Keep business logic (tier calculation, split math, status→access mapping, token minting) in **pure, testable functions**, separate from HTTP/UI.
- Prefer **server components / server actions** for data; reach for client components only when interactivity needs it.
- Paginate list endpoints (e.g. marketplace) from the start; never ship an unbounded query.
- One way to do each thing. Consistent naming. No dead code, no half-finished abstractions.

## Correctness & safety net
- **All schema changes go through migrations**, never manual edits in the dashboard.
- **Test harness exists from #1** (Vitest + a test DB/seed). Don't defer it — by #5 you need it.
- **Tests on critical paths** before they are considered done: token verify (sig/exp/aud), payment split math, vendor tier calculation + boundaries, webhook idempotency + out-of-order, refund/dispute reversal, status→access mapping, RLS policies.
- **Audit log** for money and access events (who, what, when) — essential for debugging and disputes.
- **Reconciliation:** a job compares Stripe state to the DB and flags drift (orphan subscriptions, missing transfers).
- Use **Stripe test mode** + the **Stripe CLI** (`stripe listen`, `stripe trigger`) for local webhook testing until the full flow is verified end to end.

## Scalability (mostly free — do not pre-build)
- Keep APIs **stateless** (JWT, no server session affinity) so horizontal scaling is automatic.
- Do **NOT** add caching layers, message queues, microservices, or multi-region now. Add them only when real metrics demand it.

---

## §5 — Partitioning policy for hot append-only tables (#48)

Every hot append-only table must be declared `PARTITION BY RANGE (created_at)` with monthly partitions from day 1. Retrofitting partitioning after data exists requires a full rewrite + lock.

**Partitioned tables (canonical list):**

| Table | Task | Retention |
|---|---|---|
| `audit_log` | #2/#48 | 18 months raw → S3 archive |
| `jobs` | #48 | succeeded 14d, failed/dead 90d → detach |
| `vendor_webhook_deliveries` | #48/#39 | 60d |
| `analytics_events` | #46 | 90d raw → roll up to `analytics_daily` |
| `analytics_daily` | #46 | forever (aggregated) |
| `run_steps` | #42 | 180d |
| `notifications` | #39 | 180d |
| `usage_events` | #40 | never purge (financial) |
| `credit_transactions` | #40 | never purge (financial) |

**Pattern for any new hot table:**
```sql
CREATE TABLE public.foo (
  ...,
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
-- Migration comment MUST state: table, partition key, retention window
```

**Partition rotation:** the `partition-rotation-cron` Edge Function (runs 25th of each month) calls `create_next_month_partitions()` to create the next 2 months and `detach_partition_if_exists()` for expired partitions per the retention table above. Never `DROP` a partition without first archiving to S3.

**Every future build that creates a hot table MUST:**
1. Add `PARTITION BY RANGE (created_at)` in the migration.
2. Add seed partitions for the current + next 2 months.
3. Add the table + retention to the canonical list above.
4. Add the table to `partition-rotation-cron/index.ts` `PARTITIONED_TABLES`.

---

## §6 — Migration safety pattern (#48)

Never take an `AccessExclusiveLock` on a hot table in production. Forbidden shortcuts:

- `ALTER TABLE t ADD COLUMN col NOT NULL DEFAULT expr` — full rewrite, blocks all reads/writes.
- `CREATE INDEX` without `CONCURRENTLY` — blocks writes.
- `ALTER TABLE ... ADD CONSTRAINT` without `NOT VALID` — validates inline, blocks.
- `ALTER TYPE ... ADD VALUE` inside a transaction — Postgres forbids it anyway.

**Required pattern for adding a column to a live table:**
```sql
-- Step 1: nullable add — instant (no rewrite, no lock)
ALTER TABLE public.foo ADD COLUMN bar text;

-- Step 2: backfill in batches (as a 'backfill' jobs row or looped UPDATE)
UPDATE public.foo SET bar = 'default' WHERE bar IS NULL AND id IN (
  SELECT id FROM public.foo WHERE bar IS NULL LIMIT 10000
);
-- Repeat until count = 0.

-- Step 3: set NOT NULL once backfill complete
ALTER TABLE public.foo ALTER COLUMN bar SET NOT NULL;
```

**Required pattern for indexes:**
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS foo_bar_idx ON public.foo (bar);
```

**Required pattern for constraints:**
```sql
ALTER TABLE public.foo ADD CONSTRAINT foo_check CHECK (bar > 0) NOT VALID;
ALTER TABLE public.foo VALIDATE CONSTRAINT foo_check; -- separate transaction, no lock
```

---

## §7 — RLS performance rules (#48)

Load-bearing from the moment `is_org_member` / `my_org_ids` are used in policies. A per-row scalar subquery on a 10M-row table will kill the database.

**Rules (all mandatory):**
1. `is_org_member(org_id, min_role)` and every RLS helper that queries a lookup table **MUST** be `STABLE SECURITY DEFINER`. This lets Postgres cache the result per query, not per row.
2. `org_members` **MUST** have `(user_id, org_id) INCLUDE (role)` composite index — the helper is one indexed lookup.
3. Policies **MUST** filter by `org_id` first so partition-pruning + index lookup happen before the helper runs. Pattern:
   ```sql
   USING (org_id = ANY(SELECT public.my_org_ids()))
   ```
4. Every RLS-protected hot table **MUST** have an `org_id` index.
5. Forbidden: `auth.uid()` in subqueries that run per-row on large tables — always wrap in the cached helper.
6. Verify with `EXPLAIN (ANALYZE, BUFFERS)` after adding any new policy on a large table. Seq scan = reject.

---

## §8 — Edge caching policy (#48)

At scale, every page render hitting Postgres is catastrophic. Use Next.js ISR + on-demand revalidation via `lib/cache/revalidate.ts`.

| Surface | Cache strategy | TTL | Invalidated by |
|---|---|---|---|
| `/marketplace` | ISR | 60s | `revalidateMarketplace()` on app approve/edit/feature |
| `/app/[slug]` | ISR | 300s | `revalidateApp(slug)` on screenshot/review/price change |
| `/r/[reseller]/[offer]` | ISR | 300s | `revalidateStorefront()` on offer-status change |
| `/_wl/[reseller]/[offer]` | ISR | 300s | `revalidateWLStorefront()` on offer-status/brand change |
| `/affiliates/top` | ISR | 900s | `revalidateLeaderboard()` on MRR update |
| `/affiliates/[slug]` | ISR | 900s | `revalidateAffiliateProfile(slug)` on badge/profile update |
| Authenticated dashboards | No cache | — | React `cache()` for per-request memoization |

**Rule:** any service-layer mutation that changes a cached surface **MUST** call the matching `revalidate*` function from `lib/cache/revalidate.ts`. Never hardcode tag strings.

---

## §9 — Async job queue conventions (#48)

All previously fire-and-forget paths (erasure, export, webhook delivery, analytics rollup, usage settlement) MUST use the `jobs` table + `jobs-worker-cron` worker. Never fan out work inline from a webhook handler or API route.

**Handler contract:**
- Handlers live in `lib/jobs/handlers.ts` (server) and `supabase/functions/jobs-worker-cron/index.ts` (Edge).
- Handlers MUST be idempotent — a retry must produce the same outcome.
- Long work MUST split into multiple jobs (e.g. erasure enqueues one job per eraser).
- Handlers MUST be registered in BOTH the server-side registry (for tests) and the Edge Function (for production).

**`enqueueJob` from creation paths:**
```ts
await enqueueJob("webhook_delivery", { endpointUrl, eventType, body, secret, deliveryId, orgId }, {
  idempotencyKey: `wh:${deliveryId}`,
  orgId,
});
```

**Dead job replay:** admin calls `replayJob(jobId)` or uses the admin DLQ UI (#36). Never manually update `status` — use the helpers.

---

## §10 — Quota enforcement (#48)

Every new creatable resource MUST have a quota column in `org_quotas` + an `enforceQuota()` call in the creation path. **Default-deny stance** — never silently allow unbounded resource creation.

**Pattern:**
```ts
// In server action or API route, before INSERT:
await enforceQuota(orgId, "offers"); // throws QuotaExceededError on breach
await admin.from("reseller_offers").insert({ ... });
```

**Adding a new resource type:**
1. Add `max_<resource>` column to `org_quotas` with a sensible default.
2. Add a backfill `UPDATE org_quotas SET max_<resource> = <default>` in the migration.
3. Add the resource to `RESOURCE_CONFIG` in `lib/quotas/enforce.ts`.
4. Add `await enforceQuota(orgId, "<resource>")` before every INSERT.
5. Admin UI (#36) must expose the per-org override (audit-logged write via service role).

---

## §11 — Load-test baselines (#48)

k6 smoke harness: `scripts/loadtest/smoke.js`. Run against seeded local stack.

**Expected p95 / p99 baselines (M1 laptop, local Supabase):**

| Path | p95 | p99 |
|---|---|---|
| `GET /marketplace` (ISR hit) | < 80ms | < 150ms |
| `POST /api/events` beacon | < 40ms | < 80ms |
| Stripe `invoice.paid` webhook (DB write) | < 500ms | < 1000ms |
| Usage draw-down (concurrent lock) | < 200ms | < 400ms |

Update this table after each smoke run. A regression in any baseline is a P2 issue.

## Definition of done for any prompt
Code compiles with strict TS, inputs are validated with Zod, money/access paths have tests, RLS covers and tests new tables, the prompt's Verify step passes, and the Progress checklist in `CLAUDE.md` is updated.
