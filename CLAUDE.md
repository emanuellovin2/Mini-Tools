# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# [PLATFORM]

A multi-sided marketplace where developers list SaaS apps and sell them on subscription; affiliates bring users via referral links; resellers run their own storefronts with markup over a vendor-set floor. The platform owns billing, access, and distribution.

**Economics at a glance:**
- **Vendor (direct sale):** platform takes 12%/8%/5%/3% by trailing monthly net tier ($0–$1k / $1k–$3k / $3k–$10k / $10k+). Computed on net amount (after Stripe fees). **No flat fee.**
- **Affiliate (referral):** vendor sets `affiliate_commission_bps` per app (20–80%). On affiliate sales: platform takes **5% of net**, affiliate gets their set %, vendor keeps the rest. Affiliate tier: 20%/25%/30% at $0/$5k/$20k active MRR generated. Commission snapshotted at subscribe time — tier changes only affect new subs.
- **Reseller (storefront):** pays **$19/month** for platform access (30-day free trial). On each sale: vendor gets `min_price` floor, platform takes **5% of markup** (Tier 1) or **2.5% of markup** (Tier 2 WL), reseller keeps the rest. Vendor with `open_to_wl` gets 33% kickback on platform commission (both tiers).

## Next.js version note
This project uses **Next.js 16** — breaking API changes not reflected in most LLM training data. Read `node_modules/next/dist/docs/` (start with `01-app/`) before writing any Next.js-specific code.

## Commands
```bash
npm run dev && npm run typecheck && npm test
npm test -- --run <path>   # single test file
npm run types              # regenerate types/supabase.ts
supabase start / stop / db push
stripe listen --forward-to localhost:3000/api/webhooks
```

## Read these first
1. **`SPEC.md`** — source of truth: architecture, roles, pricing, schema, business rules.
2. **`BUILD_PROMPTS.md`** — ordered build plan index (files in `build_prompts/`).
3. **`ENGINEERING.md`** — engineering principles (money as cents/bps, Separate Charges & Transfers, idempotent webhooks, RLS, strict TS).

## Key file locations
```
lib/services/          # service layer (apps.ts, solutions.ts, vendor.ts, buyer.ts, admin.ts, affiliate.ts, reseller.ts, org.ts, analytics.ts, reconciliation.ts, api-keys.ts, notifications.ts, onboarding.ts, export.ts, vendor-webhooks.ts, agency.ts, deployments.ts, outcomes.ts, usage.ts, gateway.ts, client-portal.ts, privacy.ts)
lib/privacy/erasers.ts # #45 eraser registry — each store registers an idempotent (partnerClientId) => void eraser
lib/gateway/           # AI gateway: crypto.ts (envelope encryption), providers/{openai,anthropic,compat}.ts (adapters)
lib/usage/split.ts     # pure priceUnit + computeUsageSplit (flat/tiered/volume, BYOK/managed, fuzz-tested)
lib/stripe/            # billing.ts (computeTier), transfers.ts, webhook-handlers.ts, connect.ts, products.ts, with-retry.ts
lib/auth/              # permissions.ts (can()), jwt.ts, roles.ts, sdk.ts
lib/jobs/              # queue.ts (enqueueJob/claimJobs), handlers.ts
lib/quotas/enforce.ts  # enforceQuota() — default-deny for all new resources
lib/db/with-timeout.ts # withFastTimeout / withStandardTimeout / withCronTimeout
lib/pricing/preview.ts # pure preview fns for live fee calculators
lib/search/solutions.ts # SearchIndex<T> interface — marketplace queries go through here
lib/types/solutions.ts  # Zod discriminated union per solution_type
lib/cache/revalidate.ts # tagged ISR invalidation helpers
lib/validation/env.ts   # boot-time Zod env validation (authoritative list of env vars)
lib/analytics/          # hash.ts, funnel.ts
lib/agency/churn-risk.ts # computeChurnRisk pure fn (mirrors refresh_client_health_scores SQL)
lib/knowledge/         # vector-index.ts (interface), pg-vector-index.ts (impl + factory), embeddings/{index,openai,compat}.ts, ingest/{parse,chunk,embed}.ts, graph.ts (stub)
lib/services/knowledge.ts  # bases + documents CRUD, ingest dispatch, retrieve(), debugRetrieve()
app/settings/knowledge/    # list bases, create, per-base doc management + Enrich Engine button
app/api/knowledge/upload/  # POST — magic-bytes verified file upload to knowledge-uploads bucket
app/api/knowledge/debug-retrieve/ # POST — admin-only relevance panel
lib/connectors/        # registry.ts (static defs), handlers/{http,gmail,slack,sheets}.ts
lib/services/connectors.ts # signState/verifyState (OAuth CSRF), connectAccount, handleOAuthCallback, refreshTokenIfExpired, runConnectorAction
app/settings/connections/ # Connections dashboard (list + revoke), OAuth success/error feedback
app/api/connectors/[id]/connect/   # GET → redirect to provider OAuth consent
app/api/connectors/[id]/callback/  # GET → exchange code, store encrypted tokens, redirect
app/vendor/            # vendor dashboard + actions
app/marketplace/       # public browse (uses solutionsIndex)
app/buyer/             # buyer dashboard v2
app/affiliate/         # affiliate dashboard + public profiles
app/affiliates/        # public leaderboard + profile pages
app/reseller/          # reseller dashboard + offers + brand
app/admin/             # admin dashboard + reconciliation
app/client/            # client portal (org.type='client' only); outcome charts, wallet, privacy
app/_client/           # internal: branded client portal for agency subdomains (sets cp_branding cookie)
app/r/ + app/_wl/      # public storefronts (Tier 1 + Tier 2 WL)
app/legal/fees/        # canonical fee schedule page
app/legal/dpa/         # #45 Data Processing Agreement (platform as processor)
app/legal/subprocessors/ # #45 sub-processor list (Stripe, Supabase, Vercel, Resend, AI providers)
app/settings/client-data/ # #45 partner panel — raise export/erasure for clients
app/api/               # webhooks/, stripe/, affiliate/, reseller/, v1/, events, verify, launch
components/ui/         # design system primitives (Button, Card, Drawer, Sparkline, KpiCard, DenseTable, EmptyState, Toast, Badge, Skeleton, CommandPalette, NotificationBell, Lightbox)
components/layout/     # DashboardShell, Sidebar, Topbar, PageHeader
proxy.ts               # Next.js middleware: auth, role routing, ?aff= capture, subdomain rewrite
supabase/migrations/   # all schema changes — never manual dashboard edits
```

## Data models (non-obvious schema decisions)

**Reseller (as of #29)**
- `profiles.reseller_openness` (`closed|open_to_resellers|open_to_wl`; default `open_to_resellers`) — vendor-set. Only affects reseller sales.
- `reseller_offers.wl_tier` (1|2), `wl_status`, `wl_stripe_subscription_id` (UNIQUE per offer), per-offer branding columns.
- `subscriptions.reseller_wl_tier_snapshot / vendor_openness_snapshot` — immutable after subscribe.
- `VENDOR_WL_KICKBACK_BPS = 3333` in `lib/stripe/transfers.ts` — never inline.

**Screenshots (as of #30)**
- `solutions.screenshot_urls text[]` — first element = marketplace hero. CHECK: cardinality 0 (pending) or 3–7 (active). Approved require ≥3.
- Storage bucket `app-screenshots`: public read, vendor-prefixed write.

**Design system v2 (as of #31)**
- Tokens in `app/globals.css`: `--font-size-base: 13px`, `--primary: 245 100% 68%` (#635bff), `--sidebar-w: 232px`, `--topbar-h: 56px`. Dark mode via `html[data-theme="dark"]`.
- Primitives: `Drawer` (520px, focus trap), `Sparkline`, `KpiCard`, `DenseTable/Row/Cell`, `EmptyState`, `Tooltip`, `OnboardingChecklist`, `NotificationBell`, `CommandPalette` (⌘K). No new primitives without reason.
- Per-role layouts in `app/{vendor,affiliate,admin,reseller}/layout.tsx` wrap DashboardShell.

**Affiliate (as of #25)**
- `profiles.affiliate_active_mrr_cents` drives tier + leaderboard. `profiles.slug` UNIQUE globally (NULL = opted out).
- `affiliate_badges` — static lookup; earned badges via `affiliate_earned_badges(p_affiliate_id)` RPC.
- Public MRR must be **rounded** (nearest $100) — exact figures expose subscriber counts.

**Organizations (as of #47 + #50)**
- `organizations`: `id, name, slug (nullable for personal), type (personal|team|agency|client)`, `region text DEFAULT 'us-east-1'`. Stripe Connect columns live here (not profiles).
- `org_members`: `(org_id, user_id)` UNIQUE, `role (owner|admin|member)`. Index: `(user_id, org_id) INCLUDE (role)`.
- `jobs`: durable async queue — erasure, export, analytics rollup, settlement, webhook delivery.
- `org_quotas`: default-deny for every new resource type. Every creatable resource MUST have quota + enforcement.
- `audit_log.actor_org_id`: stamp on every mutation. `writeAuditLog` in same transaction.
- `apps/reseller_offers/affiliate_links/vendor_billing` gain `org_id`. `profiles.role` = platform role; `org_members.role` = within-org.

**Analytics (as of #46)**
- `analytics_events`: append-only, monthly partition, 90d raw retention. `visitor_hash` = salted daily-rotating HMAC (null on DNT/GPC). No PII, no raw IP.
- `analytics_daily`: rollup kept indefinitely. `analytics-rollup-cron` (0 3 * * *) → `rollup_analytics_day(date)` RPC.
- `POST /api/events`: batched (max 20), rate-limited 60/min/IP, bot-filtered.
- `ANALYTICS_SALT_SECRET` required env var (falls back to `dev-salt-not-for-production` with warning).

**Agency ↔ Client + Deployments (as of #50)**
- `organizations.type` extended: `'agency'` (operators) and `'client'` (SMB end-buyers). `type='personal'` orgs are unchanged.
- `client_relationships`: agency↔client binding. Partial unique index `(client_org_id) WHERE status='active'` — one active agency per client. Status: `invited|active|paused|ended`. Ending cascades deployments to `'orphaned'` (trigger). `lib/services/agency.ts` for invite/accept/pause/end lifecycle.
- `solution_deployments`: operational unit for `solution_type IN ('agent','workflow','bundle')` (SaaS keeps subscriptions). Key columns: `agency_org_id` (nullable — NULL = marketplace-direct), `client_org_id`, `runtime_config_override jsonb`, `region text` (immutable, denormalized from client org at insert), `tenant_shard_id smallint DEFAULT 0` (sharding seam). Trigger prevents SaaS solutions. Trigger requires active relationship when `agency_org_id` is set.
- `getEffectiveConfig(deploymentId)` in `lib/services/deployments.ts` — merges `solutions.runtime_config` + `runtime_config_override`. Redis-cached (5 min) + in-process LRU (30 s). **#41 and #42 must ONLY read config via this function, never raw rows.**
- RLS: client reads own deployments, agency reads operated deployments, vendor reads aggregate via `get_vendor_deployment_stats()` RPC only (no raw rows). No cross-tenant reads.
- Orphaned deployments: can be adopted (`operated_by=NULL`), transferred to new agency, or archived. Auto-archived after 90 days via pg_cron.

**Client portal (as of #53)**
- `organizations.portal_branding jsonb` — agency-set branding (logo_url, brand_color, display_name) for client-facing surfaces.
- Signed branding cookie (`cp_branding`): HMAC-SHA256, 1h TTL, `CLIENT_BRANDING_SECRET` env var. `encodeBrandingCookie`/`decodeBrandingCookie` in `lib/services/client-portal.ts`.
- Redis `branding_version:{clientOrgId}` counter — bump via `bumpBrandingVersion()` on agency branding update to invalidate cookies.
- `resolveSlugOrgType(slug)` — Redis-cached (5 min) lookup used in proxy.ts to route agency subdomains to `/_client/[slug]/` vs. reseller subdomains to `/_wl/[slug]/`.
- `/_client/[agency-slug]/` internal route sets branding cookie + shows branded landing page. `/client` is the authenticated client dashboard.
- `client_welcome_email` job enqueued in `acceptAgencyInvite`; handler in `lib/jobs/handlers.ts`; email in `lib/email/resend.ts → sendClientWelcomeEmail`.
- "Hosted by [PLATFORM]" footer is mandatory in both `/client` layout and `/_client/` layout.

**AI Gateway (as of #41)**
- `provider_keys`: envelope encryption (per-record DEK wrapped by versioned master key). `KEY_VAULT_MASTER_KEYS` (JSON versioned map) + `KEY_VAULT_ACTIVE_VERSION`. `lib/gateway/crypto.ts` → `encryptSecret/decryptSecret` — reused by #43. `rotateMasterKey()` re-wraps DEKs only.
- `gateway_products`: one per solution linking to a `usage_meter` + AI config (model, system_prompt, max_tokens_cap, cost_mode). `solution_id` UNIQUE.
- `gateway_tokens`: hashed non-browser tokens. Spend caps daily/monthly. Anomaly spike → auto-pause. Revocation immediate (hash compare per call).
- `gateway_reservations`: reserve-then-settle pattern. `reserve_credits()` RPC locks wallet, accounts for in-flight holds. `release_reservation()` on failure. `expire_gateway_reservations()` sweeps every 5 min via pg_cron.
- `POST /api/gateway/[provider]?deployment_id=<id>`: auth via session OR `Bearer gw_*` token. Rate-limited (NOT webhook-exempt). No credits → 402 before provider call. Idempotency-Key deduplication.
- Provider adapters: `lib/gateway/providers/{openai,anthropic,compat}.ts`. Adding a provider = new file only. Streams teed: one to client, one to parse usage SSE for settlement.
- `GATEWAY_ENABLED` env flag gates the route. Plaintext keys never leave server, never in any log.

**Workflow engine (as of #42)**
- `workflows`: `owner_id` → `organizations.id` (org-owned). `trigger_type` enum (`manual|schedule|webhook`). `webhook_secret` required when `trigger_type='webhook'`.
- `workflow_steps`: editable draft steps; counted for `max_workflow_steps` quota. `position` + `next_step_key` form the execution order.
- `workflow_versions`: immutable snapshots at publish time (`graph` jsonb). Capped at 50 per workflow by trigger. Runs pin a version. `template_of_id` for attribution on installs.
- `workflow_runs`: durable state machine. `next_step_key` + `next_run_at` = cursor. `usage_event_id` guards against double-charge on retry. `claim_workflow_run(p_worker_id)` RPC = `SELECT ... FOR UPDATE SKIP LOCKED`.
- `run_steps`: per-step checkpoint; `idempotency_key = {run_id}:{step_key}:{attempt}`. Executor resumes from last incomplete step on crash with no duplicate side effects.
- Executor design: `executeRun(runId)` in `lib/services/workflows.ts` → one step per invocation. Delay step sets `next_run_at`; no long-running function. `workflow-runner-cron` Edge Function (every minute) claims due runs + enqueues `workflow_execute` jobs.
- Step types: `ai` (BYOK via key vault, non-streaming sync call), `http` (outbound fetch), `transform` (safe `{{path}}` template expansion — NO eval), `branch` (condition evaluator — NO eval), `delay` (future `next_run_at`), `connector` (`runConnectorStep` in `lib/workflows/steps/connector.ts` — live as of #43).
- Template install (`installTemplate`): clones a `is_template=true` version into buyer's org; strips `provider_key_id` from step configs (buyer supplies own keys).
- Key files: `lib/services/workflows.ts`, `lib/workflows/steps/{ai,http,transform,branch,delay,connector}.ts`, `app/api/workflows/[id]/trigger/[secret]/route.ts`, `supabase/functions/workflow-runner-cron/`.

**Connectors (as of #43)**
- `connector_accounts`: org-owned encrypted credential vault. Same AES-256-GCM envelope pattern as `provider_keys` — `ciphertext`/`dek_wrapped`/`key_version` for access token; `refresh_*` trio for refresh token. `expires_at` null = non-expiring. `org_id` column (not `owner_id`).
- Registry in `lib/connectors/registry.ts`: HTTP (none auth), Gmail (oauth2), Slack (oauth2), Sheets (oauth2). Adding a connector = new `ConnectorDef` + handler file in `lib/connectors/handlers/`.
- OAuth flow: `GET /api/connectors/[id]/connect` → consent; `GET /api/connectors/[id]/callback` → exchange code, encrypt + store. State is HMAC-SHA256 signed (15-min expiry) via `CONNECTOR_STATE_SECRET`.
- Auto-refresh: `ensureFreshToken()` in `lib/services/connectors.ts` re-encrypts new tokens. Called before every step execution. Throws if expired and no refresh token (reconnect required).
- Quota: `connector_accounts` default 20 per org (enforced in `connectAccount`).
- Env vars: `CONNECTOR_STATE_SECRET` (required), `GOOGLE_CLIENT_ID/SECRET` (optional, for Gmail+Sheets), `SLACK_CLIENT_ID/SECRET` (optional).

**Outcome metrics (as of #51)**
- `deployment_metrics`: append-only, **daily** partition (not monthly). `tenant_shard_id` first in all composites. 90d raw retention; detached by `partition-rotation-cron`.
- `deployment_metrics_rollup`: indefinite daily summaries. `rollup_watermark` per `(deployment_id, metric_key, dimensions_hash, date)` row; idempotent ON CONFLICT. `cardinality_overflow=true` when >1000 distinct dimension combos/day for a metric.
- `emitMetric` in `lib/services/outcomes.ts` — only write path. `volume_class='high'` → jobs queue (`outcome_emit_batch`); low/medium → sync insert. Cross-partition idempotency: 7-day window app-layer check.
- `dimensions` jsonb: max 16 keys, values max 64 chars, no PII (email/phone/PAN rejected at service layer + DB CHECK). `hasPiiValue()` exported for tests.
- Reserved key namespaces: `lead.*` `meeting.*` `task.*` `time.*` `revenue.*` `cost.*` `quality.*`. Custom keys: `custom.<vendor_slug>.<key>`.
- `getSolutionOutcomeBenchmarks` — vendor-callable RPC; enforces k≥5 deployments before returning aggregates.
- `outcomes_archive_router` — stub reads hot rollup; future S3 cold-storage path for >24mo data.
- Rollup cron: `outcomes-rollup-cron` Edge Function every 15 min → enqueues `outcomes_rollup_partition` jobs → calls `rollup_outcomes_window(date)` RPC.
- RLS: client reads own, agency reads operated, vendor reads nothing direct (benchmarks RPC only), admin reads all.

**Partner-client data lifecycle (as of #45)**
- `partner_clients`: canonical PII registry (`id`, `partner_owner_id → organizations`, `external_ref`, `email`, `display_name`, CRM fields: `tags text[]`, `lifecycle_stage`, `notes`, `last_seen_at`, `deleted_at` soft-delete). All other stores reference `partner_client_id` — PII never duplicated.
- `partner_data_requests`: tracks export/erasure jobs (`request_type enum('export'|'erasure')`, `status`, `grace_ends_at`, `job_id`, `result_url`).
- `usage_events.partner_client_id` + `workflow_runs.partner_client_id` — nullable linkage columns added in migration.
- `lib/privacy/erasers.ts` — eraser registry; each store registers an idempotent fn. `runAllErasers(partnerClientId)` fans out to all.
- Erasure: soft-delete immediate (halts processing) → grace window (default 30 days, `ERASURE_GRACE_DAYS` env) → `partner_client_erasure_hard` job fans out hard erasure. Financial aggregate rows KEPT (accounting); only identity linkage removed.
- Retention cron (pg_cron, 04:00 UTC): purges `run_steps.input/output` older than 90 days; hard-deletes soft-deleted client rows past grace.
- Env vars: `ERASURE_GRACE_DAYS` (default 30), `RETENTION_DAYS_WORKFLOW_RUN_IO` (default 90), `RETENTION_DAYS_GATEWAY_LOGS` (default 90).
- RLS: only `partner_owner_id` org members + admin; no other counterparty sees identity (SPEC §13).
- `/legal/dpa` + `/legal/subprocessors` — public processor-stance docs; `/settings/client-data` — partner panel to raise export/erasure.

**Solutions abstraction (as of #49)**
- `solutions` table (renamed from `apps`). Legacy `CREATE VIEW apps AS SELECT * FROM solutions` — existing code works unchanged.
- `solution_type enum('saas'|'agent'|'workflow'|'bundle') DEFAULT 'saas'`. Non-SaaS types gated by `SOLUTIONS_NON_SAAS_ENABLED=true`.
- New columns: `runtime_config jsonb`, `template_of_id uuid`, `is_template bool`, `solution_version text (semver)`, `tenant_shard_id smallint DEFAULT 0`.
- `solution_versions` table — capped at 50 per solution. Triggers: type immutability after approval, no bundle-in-bundle, semver no-downgrade.
- All marketplace listing pages route through `solutionsIndex` (`lib/search/solutions.ts`) — never raw table queries from page code.
- Zod discriminated union per type in `lib/types/solutions.ts`. `lib/services/solutions.ts` for CRUD + template fork + version history.

**Knowledge & RAG (as of #55)**
- `knowledge_bases`: grouping unit per embedding generation. `visibility` (`private|org|public`). `embedding_model` pinned at creation — all chunks in the base share it. `tenant_shard_id` immutable; data residency via `region`.
- `knowledge_documents`: one row per source artifact. `source_type` (`upload|url|connector`). `(knowledge_base_id, content_hash)` UNIQUE — idempotent re-upload returns existing doc. Status machine: `pending→parsing→chunking→embedding→ready|failed`. Soft-deleted; hard-erased via #45 eraser.
- `knowledge_chunks`: retrieval unit. **Partitioned `BY LIST (tenant_shard_id)`** — shard column first in all composite indexes. `embedding vector(1536)` (HNSW `vector_cosine_ops`). `fts tsvector GENERATED` for hybrid retrieval. `embedding_version` allows dual-generation zero-downtime reindex.
- **`VectorIndex` interface** (`lib/knowledge/vector-index.ts`): all vector reads/writes go through this. pgvector impl in `pg-vector-index.ts`. No service code imports vector queries directly — CI grep-enforced.
- **`EmbeddingProvider` interface** (`lib/knowledge/embeddings/index.ts`): mirrors gateway provider pattern. Adding a provider = one new file. BYOK per org via `#41` vault; platform key fallback for `cost_mode='managed'`.
- **Ingest pipeline** (all async on jobs queue): `knowledge_parse` (text extraction + hash + idempotency check) → `knowledge_embed_batch` (chunk + embed + upsert + meter) → status=ready. `knowledge_reindex` = Enrich Engine: new `embedding_version` rows alongside old; `MAX(version)` wins in RPC.
- **`match_knowledge_chunks` RPC**: `STABLE SECURITY DEFINER`. Org + base filter inside the function (defense-in-depth). Hybrid vector + FTS via **Reciprocal Rank Fusion**.
- **Gateway integration** (#41): `gateway_products.knowledge_base_ids` → retrieve top-k → inject as system context before provider call (gated by `KNOWLEDGE_ENABLED`).
- **Workflow `ai` step** (#42): `knowledge_base_ids` config field — same retrieval-then-inject pattern.
- Erasure: `knowledge` eraser registered in `lib/privacy/erasers.ts`.
- Quotas: `knowledge_bases` (default 10/org), `knowledge_documents` (default 500/org). `enforceQuota()` in creation paths.
- Env vars: `KNOWLEDGE_ENABLED` (flag), `EMBEDDING_PROVIDER` (default `openai`), `EMBEDDING_MODEL` (default `text-embedding-3-small`), `EMBEDDING_DIMS` (default `1536`), `KNOWLEDGE_MAX_DOC_BYTES` (default 25MB), `EMBEDDING_COMPAT_BASE_URL` (required for `openai_compat` provider).
- Storage bucket `knowledge-uploads`: org-prefixed paths, private read. Upload validation: magic-bytes verified, no SVG, size-capped (same pattern as brand uploads).
- ENGINEERING.md §13 documents the abstraction rules; violation = reject PR.

## How to work
- Build one numbered prompt at a time. Tick it in Progress when done.
- Tech stack (do not swap): Next.js App Router TS, Supabase, Vercel, Stripe Connect, Resend, JWT RS256.
- See `lib/validation/env.ts` for the authoritative list of environment variables + which task requires each.

## Progress
**Phase 0–2 (done):** #1–#14 all complete.

**Phase 3 Wave 1–6 (done):** #15–#26 all complete (pricing tiers, design system, affiliate redesign, refund policy, subscription pause, vendor analytics, affiliate leaderboard, docs sync, weekly payouts, reseller trial).

**Phase 4 Wave 7 (done):** #27 vendor commission override, #28 security hardening v2, #29 WL Tier 2.

**Phase 5 Wave 8 (done):** #30–#39 all complete (screenshots gallery, design system v2, vendor/affiliate/reseller/buyer/admin dashboard v2, marketplace v2, fee transparency, cross-role notifications/settings/onboarding/CSV/webhooks/partner API).

**Phase 6 — Wave 9 (Stripe + Shopify for AI agencies)**

Repositioning: infrastructure agencies use to build agent-powered businesses for SMB clients. BYOK + prepaid credits = zero compute cost to platform. `agency↔client relationship` as primary op unit. `deployments` (not subscriptions) for agent/workflow/bundle. Foundation ordering: **#47 → #48 → #46 → #49 → #54 → #50 → #51 → #40–#44 → #52+#53 → #45**.

- [x] #47 Organizations & multi-seat — `organizations`, `org_members`, personal-org bootstrap, RLS via `is_org_member`, payouts move to org, `audit_log.actor_org_id`
- [x] #48 Scale & resilience — durable `jobs` queue + tick worker, `org_quotas` + enforce, statement_timeout middleware, outbound webhook delivery, k6 smoke harness, Stripe retry wrapper
- [x] #46 Analytics event capture — `analytics_events` (monthly partition, privacy-safe), rollup cron, real funnels (affiliate EPC, reseller traffic, vendor impression)
- [x] #49 Solutions abstraction — `apps→solutions` rename + legacy view, `solution_type` enum, `runtime_config`, `template_of_id`, `solution_versions`, search interface, `SOLUTIONS_NON_SAAS_ENABLED` flag
- [x] #54 Wave 9 scale invariants — `lib/search/index.ts` interface + Postgres impl, `lib/db/with-replica.ts` + `with-region.ts`, `organizations.region` + `custom_domain`, `settlement_batches`, `idempotency_keys_v2` TTL partitions, tenant noisy-neighbor (pg_cron kill + `tenant_query_stats` mview), `lib/reserved-slugs.ts` single source, `lib/cold-storage/index.ts` stub, `CUSTOM_DOMAINS_ENABLED` flag, ENGINEERING.md §12 + k6 Wave 9 scenarios
- [x] #50 Agency ↔ Client + Deployments — `organization_type` extended (`agency`|`client`), `client_relationships` (one active agency per client), `solution_deployments` as op unit for non-SaaS (SaaS keeps subscriptions), `getEffectiveConfig` Redis-cached (5min + 30s LRU), RLS trust boundaries. **BLOCKS #51–#53, refits #40–#44.**
- [x] #51 Outcome metrics seam — `deployment_metrics` (daily partition, append-only), `emitMetric` idempotent, reserved namespaces (`lead.*`/`meeting.*`/`task.*`/`time.*`/`revenue.*`/`cost.*`/`quality.*`), k≥5 anonymity on benchmarks, PII dimension guard, incremental 15-min rollup with watermark.
- [x] #40 Usage metering + billing — `usage_meters`, `usage_events` (monthly partitioned), prepaid `credit_wallets`, `record_usage` RPC (atomic, idempotent), `computeUsageSplit` pure fn + fuzz tests, settlement jobs, usage reconciliation, `subscriptions.acquired_by` + `partner_owner_id` (SPEC §13), SPEC §14.
- [x] #41 AI Gateway (BYOK) — per-deployment key routing (vendor/agency/client BYOK), spend caps, encrypted `provider_keys` vault, `/api/gateway/[provider]` metered proxy.
- [x] #42 Workflow engine — `workflows/workflow_steps/workflow_versions/workflow_runs/run_steps`, triggers (manual/schedule/webhook), tick-driven durable executor (one step per cron slice), sellable templates, `claim_workflow_run` RPC.
- [x] #43 Connectors — OAuth owned by client_org, delegated to deployment; versioned registry (Gmail/Slack/Sheets/HTTP), encrypted `connector_accounts`. `CONNECTOR_STATE_SECRET` + optional `GOOGLE_CLIENT_ID/SECRET`, `SLACK_CLIENT_ID/SECRET`.
- [x] #44 Usage-product distribution — `product_kind` enum on solutions, `reseller_metered_offers` table, per-unit split via `computeUsageSplit`, marketplace badges + unit pricing, usage earnings panels in vendor/reseller/affiliate dashboards, `/legal/fees` usage section.
- [x] #52 Agency operations dashboard — `/agency` route (org.type='agency' only), client-centric health board, `client_health_scores` precomputed hourly, `computeChurnRisk` pure fn, cursor pagination (no OFFSET), Stripe Connect balance + payouts.
- [x] #53 Client portal — `/client` + subdomain WL (reuses #29 proxy pattern), branding from active agency relationship cached in signed cookie (1h) + Redis `branding_version:*`, outcome charts, credit wallet, privacy panel, agency-branded emails via jobs queue, "Hosted by [PLATFORM]" footer mandatory.
- [x] #45 DPA + partner-client data lifecycle — `partner_clients` CRM, cross-deployment erasure/export, retention cron, `/legal/dpa` + `/legal/subprocessors`, partner settings panel `/settings/client-data`. Depends on #40/#41/#43/#50.

**Phase 7 — Wave 10 (the intelligence layer) — build in order: #55 → #56 → #57 → #58 (#55/#56 parallel-able)**

- [x] #55 Knowledge & Retrieval (RAG) — `pgvector`, tenant-sharded `knowledge_bases/documents/chunks`, durable async ingest on jobs queue, `VectorIndex` + embedding-provider abstractions (swap-at-scale seam), hybrid vector+FTS retrieval RPC, gateway + workflow `ai`-step injection, metering, `knowledge` eraser, quotas. "Enrich Engine" = re-index, not training. **Substrate for #57.**
- [ ] #56 Hierarchical instruction sets — `instruction_sets` (global/project/client/deployment) + immutable `instruction_versions` (Git-like), deterministic structured merge resolved cache-first (mirrors `getEffectiveConfig` + version-counter invalidation), diff/rollback, generalizes `gateway_products.system_prompt`. Parallel-able with #55.
- [ ] #57 Multi-agent orchestration — new `agent` workflow step; durable checkpointed iterations (one per executor slice, no long-running fns), hard per-run cost ceiling via gateway reservations, loop/no-progress guards, typed handoff (Researcher→Writer→Critic), tools = connectors+http+knowledge.retrieve+sub-workflow. Depends on #55/#56/#41/#42.
- [ ] #58 Visual builder + adaptive shell — canvas over `workflow_versions.graph`, server-authoritative shared Zod graph validator (entitlement + cost-guard checks), draft/publish via existing APIs, optimistic version lock (CRDT deferred), shell toggles chat↔canvas. IDE/spreadsheet modes out of scope.

## Guardrails
- Never expose buyer email, name, or card data to vendors, resellers, or affiliates. `subscriptions.buyer_id` has no read path for non-admin roles (SPEC §6/§7).
- A user can never change their own `role` (privilege-escalation guard, RLS — SPEC §8).
- All money moves through Stripe Connect via **Separate Charges & Transfers**. **Voluntary refunds** (`charge.refunded`) reverse vendor transfer only — platform/affiliate/reseller keep cuts. **Disputes** (`charge.dispute.closed` lost) reverse ALL transfers for that invoice.
- `subscriptions` row: AT MOST ONE of `affiliate_id` / `reseller_id`. Reseller-sold takes priority — clear affiliate cookie if both collide.
- Reseller-sold revenue does NOT count toward `vendor_billing.gross_revenue_cents` (vendor tier = direct + affiliate only).
- The reseller's $19/mo subscription is on the **platform account** (not Connect). Lapse → new offers + new sales blocked (`reseller_offers.status` forced to `paused`).
- Vendor cut precedence: `profiles.vendor_cut_bps_override` (admin-set, 0–5000) → `vendor_billing.cut_bps` (auto-tier) → 1200 default. `guard_vendor_cut_override` DB trigger blocks self-set.
- Entitlement is DB-reconciled from Stripe webhooks — never grant access off a client redirect.
- Webhook handlers and any path writing to ≥2 tables MUST run in a single DB transaction (Supabase RPC or explicit BEGIN/COMMIT).
- `anon_user_id` is stable per `(buyer_id, app_id)` across resubscriptions — look up prior id before generating new.
- All admin mutations write to `audit_log` in same transaction via `writeAuditLog`. Immutable (no UPDATE/DELETE RLS).
- Webhook endpoints are exempt from rate limiting. Never add rate limiting to `/api/webhooks`.
- `VENDOR_WL_KICKBACK_BPS = 3333` exported const — never inline. CI fuzz (1000 iters) must satisfy sum invariant + non-negative platform cut.
- Brand uploads: PNG/JPG/WebP only (no SVG — XSS), 1MB max, magic-bytes verified. Display name passes homoglyph deny-list in `lib/validation/wl-brand.ts`.
- Subdomain enumeration: inactive/non-existent Tier 2 → 404. `/buyer` NEVER WL-branded — redirect to canonical domain (anti-poaching).
- Reserved subdomains/slugs: single source of truth in `lib/reserved-slugs.ts` (imported by `proxy.ts` + all slug-creation paths). Never inline the list elsewhere.
- **RLS performance:** `is_org_member()` and any RLS helper MUST be `STABLE SECURITY DEFINER`. Hot tables use `org_id = ANY(SELECT my_org_ids())` not per-row scalar calls. Never `auth.uid()` in per-row subqueries on large tables.
- **Migration safety on hot tables:** never ADD COLUMN NOT NULL DEFAULT (full rewrite). Never CREATE INDEX without CONCURRENTLY. Never ADD CONSTRAINT without NOT VALID + VALIDATE. Pattern: add nullable → batch backfill via jobs → set NOT NULL.
- **Every new creatable resource** MUST declare a quota in `org_quotas` + call `enforceQuota()`. Default-deny; never allow unbounded creation.
- **Anti-poaching (Wave 9):** vendor identity never exposed to client for agency-operated deployments. "Hosted by [PLATFORM]" footer required on all `/client` pages. Agency brand, not vendor brand, shown to clients.
