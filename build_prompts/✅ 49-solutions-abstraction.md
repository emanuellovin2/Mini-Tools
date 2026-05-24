# Task #49 — Solutions abstraction (apps → typed solutions)

> **Before starting:** read `SPEC.md` §3 (data model), §4 (roles), [supabase/migrations/](supabase/migrations/) for the current `apps` schema, [lib/services/apps.ts](lib/services/apps.ts), [lib/services/vendor.ts](lib/services/vendor.ts), [app/marketplace/](app/marketplace/), [app/app/[id]/](app/app/[id]/).
> **Definition of Done:** the `apps` table becomes a typed catalog of **solutions** (`saas | agent | workflow | bundle`), with the schema seams (`runtime_config`, `template_of_id`, `solution_type`) needed by #41/#42/#44 — but **zero behavior change for existing SaaS listings**. Every existing app row, RLS policy, RPC, marketplace query, vendor dashboard, reseller offer, and subscription continues to work unchanged. Pure additive migration + name change at the API/service layer + tests proving the seam holds.

**Phase 6 — Wave 9 foundation. Depends on: #47 (org ownership). BLOCKS #50 (deployments), #51 (outcomes), and reshapes #40–#44 + #52–#53.**

> **Why this comes before #40:** #40-#44 are about *what a solution does at runtime* (meters, gateway, workflows, connectors). Without a typed solution model, every one of them either bolts on a parallel table per type (4× the schema sprawl) or pretends an "agent" is a "SaaS app with a config blob" (silent drift, no validation, no marketplace differentiation). The seam is cheap now (one migration, one rename) and impossible later (vendor schemas, reseller offers, subscriptions, analytics, reviews all reference `app_id` — moving from a typed-by-convention to a typed-by-schema model after launch is a migration nightmare).

---

## Design constraint — NO behavior change for SaaS (NON-NEGOTIABLE)
- Every existing `apps` row migrates to `solution_type='saas'` with `runtime_config=null`. No vendor onboarding flow changes for SaaS listings in this task. No marketplace UI changes for SaaS cards in this task. No reseller offer changes.
- New types (`agent`, `workflow`, `bundle`) are **schema-ready but UI-gated** behind a feature flag (`SOLUTIONS_NON_SAAS_ENABLED`, default false). #41/#42/#44 will turn them on as they ship.
- The rename `apps → solutions` is **table-level + service-level only**. URLs (`/app/[id]`, `/marketplace`) stay — they're a marketing surface, not a data shape. A view `apps` aliases `solutions` during the transition so any missed reference still resolves; drop the view in #21 docs-sync after audit.

---

## Sections to build

### 1. Rename + retype `apps` → `solutions`
Single migration. Use `ALTER TABLE apps RENAME TO solutions` (instant, no rewrite). Add columns:
- `solution_type` enum (`saas | agent | workflow | bundle`) NOT NULL DEFAULT `'saas'` — backfill all existing rows to `saas` *in the same migration* via the default, no separate backfill job needed (default is constant, not an expression, so no table rewrite per #48 migration safety rules).
- `runtime_config` jsonb NULL — type-specific config (agent: model/system_prompt/tools; workflow: graph_id; bundle: child_solution_ids[]; saas: null).
- `template_of_id` uuid NULL → solutions(id) ON DELETE SET NULL — if this solution is a fork of another, points to its origin. Indexed.
- `is_template` boolean NOT NULL DEFAULT false — if true, this is a published template that others can fork (vendor checkbox; affects marketplace filtering in #44).
- `solution_version` text NOT NULL DEFAULT `'1.0.0'` — semver string the vendor bumps. Append-only convention enforced by trigger (can only go up). Used by #44 to track template forks against the live version.

CHECK constraints:
- `solution_type='saas' → runtime_config IS NULL` (SaaS keeps the existing `stripe_price_id` path; no runtime config needed).
- `solution_type IN ('agent','workflow') → runtime_config IS NOT NULL` (deferred enforcement: gated behind the feature flag at insert time in the service layer; constraint is `NOT VALID` initially, validated when #41/#42 turn the flag on — per #48 hot-table migration rules).
- `solution_type='bundle' → runtime_config ? 'child_solution_ids' AND jsonb_array_length(runtime_config->'child_solution_ids') BETWEEN 2 AND 20`.

Create the legacy view: `CREATE VIEW apps AS SELECT * FROM solutions;` so anything we missed still compiles. **No INSTEAD OF triggers on the view** — read-only alias. New code uses `solutions`.

### 2. Service-layer rename + type-aware queries
- Rename `lib/services/apps.ts` → `lib/services/solutions.ts`. Re-export old names from a shim file (`lib/services/apps.ts` → `export * from './solutions'`) so existing callers keep working — delete the shim in #21 docs-sync.
- All listing queries gain an optional `solution_type?: SolutionType | SolutionType[]` filter (default: all types). Marketplace queries (`getMarketplaceApps`) keep their current shape (returns everything) — UI filtering comes in #44, not here.
- Add `getTemplates(filter)` for #44: returns `is_template=true` solutions, joinable by `template_of_id` to see forks.
- Type-narrowed result types: `SolutionSaas`, `SolutionAgent`, `SolutionWorkflow`, `SolutionBundle` — discriminated union on `solution_type`. Consumers narrow with `if (s.solution_type === 'agent') { s.runtime_config.model ... }` and TS proves the access is safe. Define `runtime_config` shapes in `lib/types/solutions.ts` with Zod schemas; `createSolution`/`updateSolution` validate `runtime_config` against the schema for the type or throw `SOLUTION_RUNTIME_CONFIG_INVALID`.

### 3. Foreign-key audit (the silent-break risk)
Every table that references `apps(id)` keeps working because of the table rename + view. But every **service function, RLS policy, RPC, materialized view, cron, and edge function** that hardcodes the string `'apps'` (in `from()`, raw SQL, generated types) must be re-grepped and updated to `'solutions'`. Tables to verify (non-exhaustive — grep is the source of truth):
- `reseller_offers.app_id`
- `affiliate_links.app_id`
- `subscriptions.app_id`
- `vendor_revenue_events.app_id`
- `app_reviews.app_id` (#37)
- `analytics_events.entity_type='app'`, `entity_id` (#46)
- `vendor_billing` (per-app aggregations)
- Marketplace ISR cache tags (`lib/cache/revalidate.ts` — `revalidateApp(id)` invalidates a tag built from `'app:'+id`; keep the tag string for cache continuity, but the function now reads from `solutions`).

Acceptance: `grep -r "from('apps')" src lib app supabase` returns nothing except the legacy view definition + the rename migration itself.

### 4. Vendor onboarding — type selector (UI-gated)
In `app/vendor/apps/new/page.tsx`, add a `solution_type` select **disabled** with only `saas` selectable unless `SOLUTIONS_NON_SAAS_ENABLED` is true. Copy: "What are you listing?" with options `SaaS tool`, `AI Agent (coming soon)`, `Workflow (coming soon)`, `Bundle (coming soon)`. This single line of UI is the surface that proves the seam is real to vendors — even if non-SaaS types stay locked until #41/#42 ship, vendors see the platform's direction. No backend gating beyond the feature flag — when #41 enables the flag, the select unlocks automatically.

### 5. Reviews, analytics, attribution continuity
- `app_reviews` (#37) is type-agnostic — works for any solution type unchanged. Rename column? **No.** Keep `app_reviews.app_id` (FK to `solutions(id)`); cost of renaming the FK + every read path is not worth it. Add a code comment in the schema referencing this decision.
- `analytics_events.entity_type='app'` (#46) — extend the allowed values to include `'agent' | 'workflow' | 'bundle'` later in #41/#42. For now, keep emitting `'app'` for all SaaS rows; new types start with their own entity_type when they ship. Don't retroactively re-emit.
- Affiliate links + reseller offers keep `app_id`. They reference a `solution.id` — the *type* of that solution determines what the offer/link sells. Reseller offer logic doesn't care about type today; #44 will branch when it adds per-unit pricing for usage-based solutions.

### 6. Scale-readiness — indexes, retention, lifecycle (load-bearing for 10M+ solutions)
- **Composite indexes** (mandatory, not optional):
  - `solutions (org_id, status, solution_type, created_at DESC)` — vendor dashboard listing (the dominant query).
  - `solutions (status, solution_type, created_at DESC) WHERE status = 'active'` — marketplace listing (partial index, ~10× smaller than full).
  - `solutions (is_template, status) WHERE is_template = true AND status = 'active'` — template registry queries (#44).
  - `solutions (template_of_id) WHERE template_of_id IS NOT NULL` — fork resolution.
  - GIN index on existing `tsvector` (full-text search) stays for now, but see §7.
- **Sharding seam** (declared, not used): add `solutions.tenant_shard_id smallint NOT NULL DEFAULT 0`. Index every hot composite with it as the first column so a future shard router can `WHERE tenant_shard_id = $1 AND ...` without index rewrites. **Cost now: zero**. **Cost later (when needed): zero migration**.
- **Version retention** — `solution_version` is append-only but versions must be bounded. Add `solution_versions` history table (`solution_id`, `version`, `runtime_config_snapshot`, `published_at`, `archived_at`) capped at **50 published versions per solution** via trigger; older versions auto-archive (kept readable for active deployments referencing them, hidden from new deployments). Trigger raises `SOLUTION_VERSION_LIMIT_EXCEEDED` once cap is hit — vendor must explicitly archive old versions before publishing more.
- **Bundle constraint** — `solution_type='bundle'` runtime_config must reference solutions that are NOT themselves bundles (no nested bundles — collapses cycles + simplifies pricing/permissions). Validated by trigger that reads `solutions.solution_type` for each id in `child_solution_ids` and raises on any nested bundle.
- **Soft-delete + cascade policy** — `solutions.status` adds `'deleted'` value (vs hard DELETE). Hard DELETE blocked by FK from `subscriptions`, `solution_deployments`, `affiliate_links`, `reseller_offers` — vendor must archive (status='deleted', no new deployments) rather than delete. Existing deployments continue running; vendor receives reduced visibility but financial record intact.
- **Search seam** — current Postgres FTS scales to ~1M active solutions. Beyond that, the marketplace listing must move to an external search service (Algolia/Meilisearch/Typesense). Declare the seam in this task: all marketplace search/filter queries go through `lib/search/solutions.ts` which exports a single `searchSolutions(query, filters)` function; current impl is Postgres FTS, future impl is a drop-in. **Do not call `solutions` table directly from marketplace pages — go through the search interface.** See #54 §1 for the full search abstraction.

### 7. RLS — no policy changes, sanity tests only
The table rename preserves all existing policies (Postgres renames them with the table). Add `lib/services/__tests__/solutions-rls.test.ts` asserting:
- Vendor reads/writes only own solutions (any type).
- Public reads only `status='active'` solutions (any type) — marketplace continuity.
- Non-owner cannot mutate `solution_type` or `runtime_config` (only owner + admin).
- `solution_type` cannot be changed after creation (immutable trigger — prevents an "agent" from being repackaged as a "saas" listing mid-flight; vendors create a new solution if they need to change type).

---

## Data layer additions

```ts
// lib/types/solutions.ts (new)
export type SolutionType = 'saas' | 'agent' | 'workflow' | 'bundle';
export const AgentRuntimeConfig = z.object({ model: z.string(), system_prompt: z.string(), tools: z.array(z.string()).default([]), max_tokens: z.number().int().positive().optional() });
export const WorkflowRuntimeConfig = z.object({ graph_id: z.string().uuid() });
export const BundleRuntimeConfig = z.object({ child_solution_ids: z.array(z.string().uuid()).min(2).max(20) });
export type Solution = SolutionSaas | SolutionAgent | SolutionWorkflow | SolutionBundle;

// lib/services/solutions.ts (renamed from apps.ts)
listSolutions(filter?: { solution_type?: SolutionType | SolutionType[]; is_template?: boolean }): Solution[]
getSolution(id): Solution | null
createSolution(orgId, input): Solution      // validates runtime_config against type
updateSolution(id, input): Solution         // blocks solution_type changes; validates runtime_config
getTemplates(filter): Solution[]            // is_template=true, for #44
```

## Acceptance criteria
- [ ] `apps` table renamed to `solutions`; legacy `apps` view aliases it (drop scheduled for #21).
- [ ] All existing rows have `solution_type='saas'`, `runtime_config=null` (verified by SQL count).
- [ ] Feature flag `SOLUTIONS_NON_SAAS_ENABLED` controls non-SaaS creation; default false; documented in `.env.local.example`.
- [ ] `runtime_config` Zod-validated per type; invalid → `SOLUTION_RUNTIME_CONFIG_INVALID` error code.
- [ ] `solution_type` is immutable after insert (trigger + RLS test).
- [ ] `is_template` + `template_of_id` columns exist, indexed; forks resolvable in one query.
- [ ] `solution_version` semver-validated; trigger blocks downgrades.
- [ ] `grep -r "from('apps')"` returns only the legacy view + rename migration.
- [ ] Discriminated union types compile; `tsc --noEmit` clean.
- [ ] Existing tests pass unchanged (no behavior change for SaaS).
- [ ] New tests: solutions-rls.test.ts, runtime_config validation (4 types × valid/invalid), type-immutability trigger, template fork query.
- [ ] Vendor onboarding shows the type selector with non-SaaS options visibly disabled (UI proof of direction).
- [ ] Marketplace, reseller offers, affiliate links, subscriptions, reviews, analytics all keep working unchanged for existing SaaS rows (manual smoke + automated).
- [ ] `tenant_shard_id` column added with default 0 and indexed as first column of every hot composite (sharding seam declared, not used).
- [ ] `solution_versions` history table + 50-version trigger; archived versions readable but hidden from new deployments.
- [ ] Bundle child constraint trigger rejects nested bundles.
- [ ] Soft-delete via `status='deleted'`; hard DELETE blocked by FKs (verified by test).
- [ ] `lib/search/solutions.ts` interface created with Postgres FTS impl; all marketplace pages call it (never raw `solutions` queries from UI).
- [ ] SPEC.md §3 gains a "Solutions" subsection describing the four types + the seam; CLAUDE.md "Folder structure" updated.
