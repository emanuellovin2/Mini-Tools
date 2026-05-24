# Task #50 — Agency ↔ Client relationships + Solution deployments

> **Before starting:** read `SPEC.md` §4 (roles), §13 (client ownership / `acquired_by`), [supabase/migrations/](supabase/migrations/) for `organizations`, `org_members` (#47), [lib/services/org.ts](lib/services/org.ts), [build_prompts/49-solutions-abstraction.md](build_prompts/49-solutions-abstraction.md), [build_prompts/40-usage-metering-billing.md](build_prompts/40-usage-metering-billing.md).
> **Definition of Done:** the schema and service layer support "an **agency** operates a **deployment** of a **solution** for a **client org**." Agencies discover/onboard SMB clients; deployments are the operational unit for agent/workflow solutions (not subscriptions); existing SaaS subscriptions are untouched. RLS proves: client sees own deployments, agency sees only its managed clients' deployments, vendor sees usage stats but never PII, no other party reads across.

**Phase 6 — Wave 9 foundation. Depends on: #47 (orgs), #49 (solution types). BLOCKS #40 (deployment_id on usage_events), #51 (outcomes per deployment), #52 (agency dashboard), #53 (client portal). Required reframing for #41/#42/#43/#44.**

> **Why this can't be retrofit:** every usage event, OAuth connector token, agent run, workflow execution, billing split, and outcome metric needs to know *whose money this is* and *who operates this*. Without an agency↔client relationship + deployment as a first-class entity, every downstream task either treats `subscriptions` as the unit (wrong: subscription = one-shot purchase; deployment = ongoing operated instance with config drift) or invents its own table per task (4× sprawl). The seam is one migration now; retrofitting it after #41/#42/#43 ship means rewriting every multi-party split.

---

## Domain model (read this before writing code)

- An **agency** is an `organizations` row with `type='agency'` (new enum value, additive to #47's `personal|team`). Agencies are operators — they manage clients, build/fork solutions, sell deployments.
- A **client** is an `organizations` row with `type='client'` (also new). Clients are end-buyers (SMBs). A client org may exist independently (signed up direct) or be created by an agency on the client's behalf during onboarding.
- A **client_relationship** ties an agency org to a client org. One client org may have at most ONE active agency at a time (uniqueness constraint) — multi-agency clients are out of scope for now, deferred to a future task. Status: `invited | active | paused | ended`.
- A **deployment** is an instance of a `solutions` row, instantiated for a client org, operated by an agency org (or by the platform directly for marketplace-bought solutions — see §5). It owns its own runtime config overrides, connector account bindings (#43), credit wallet pointer, branding (WL), and status. **Replaces "subscription"** as the operational unit for non-SaaS solutions; SaaS solutions continue to use subscriptions unchanged.

## Non-goals (explicit)
- Multi-agency-per-client (one active relationship only).
- Cross-agency talent/solution sharing.
- Agency-to-agency referrals.
- SaaS deployments — SaaS keeps the existing subscription flow. Deployments are for `solution_type IN ('agent','workflow','bundle')` only. (CHECK constraint.)

---

## Sections to build

### 1. Extend `organizations.type`
Migrate the existing enum `organization_type` from `('personal','team')` to `('personal','team','agency','client')`. Pg enum extension is `ALTER TYPE ... ADD VALUE` — instant, append-only, safe on hot tables (no rewrite). All existing rows keep their current value. New values are opt-in at org creation.

Org-creation flows:
- **Agency self-signup** → `createAgencyOrg(userId, name, slug)` in `lib/services/org.ts`. Creator becomes `owner` in `org_members`. Sets `type='agency'`.
- **Client org created by agency** → `createClientOrgForAgency(agencyOrgId, clientName, primaryEmail)`. Creates the org with `type='client'`, sends invite email to the client primary (uses `org_invitations` from #47), automatically opens a `client_relationships` row with `status='invited'`. The agency operator who creates it is added as an `org_members` row with `role='admin'` so they can configure deployments on the client's behalf until the client accepts.
- **Direct client signup** (SMB self-serve, no agency) → existing personal org bootstrap creates `type='personal'` (unchanged). They can later "invite an agency to manage us" which creates a `client_relationships` row from the agency side; the org's `type` does NOT change to `client` (personal orgs keep being personal — `type='client'` is reserved for agency-originated orgs).

### 2. `client_relationships` table
```
id uuid pk
agency_org_id uuid FK organizations(id) ON DELETE RESTRICT
client_org_id uuid FK organizations(id) ON DELETE CASCADE  -- if client org is deleted, the relationship is gone
status text CHECK (status IN ('invited','active','paused','ended'))
invited_at timestamptz
accepted_at timestamptz
ended_at timestamptz
ended_reason text  -- 'client_cancelled' | 'agency_dropped' | 'admin_action'
created_at timestamptz default now()
```
Constraints:
- `UNIQUE (client_org_id) WHERE status='active'` — partial unique index enforces "one active agency per client." Easy to lift later by dropping the WHERE.
- CHECK `agency_org_id != client_org_id` (sanity).
- Index `(agency_org_id, status)` for the agency dashboard's client list query (#52).

Service functions in `lib/services/agency.ts` (new):
- `inviteClient(agencyOrgId, clientEmail, prefilledName?)` → creates client org if needed + relationship + invite email.
- `acceptAgencyInvite(token)` → client owner accepts; status `invited → active`.
- `pauseRelationship(relId, reason)` / `endRelationship(relId, reason)` — agency-initiated; client can `endRelationship` too. Audit log every transition.
- `listAgencyClients(agencyOrgId)` → returns client_relationships joined with org + last-deployment-activity + active deployment count.

### 3. `solution_deployments` table — the new operational unit
```
id uuid pk
solution_id uuid FK solutions(id) ON DELETE RESTRICT  -- vendor's solution; cannot be deleted while deployed
client_org_id uuid FK organizations(id) ON DELETE CASCADE
operated_by_org_id uuid FK organizations(id) NULL  -- the agency operating this, or null if client self-operates (marketplace-direct)
template_origin_id uuid FK solutions(id) NULL  -- if this deployment is a fork-customized template, points to origin template (denormalised from solutions.template_of_id at deploy time)
status text CHECK (status IN ('pending_setup','active','paused','failed','archived'))
runtime_config_override jsonb NULL  -- merged onto solutions.runtime_config at runtime; agency customizes here
branding jsonb NULL  -- { logo_url, brand_color, display_name } — wraps WL on client-facing surfaces (see #53)
credit_wallet_owner enum('client','agency')  -- which wallet (#40 credit_wallets) is debited per usage event; default 'client' (SMB pays for own consumption); 'agency' means the agency front-charges and pays platform out of agency wallet
created_at timestamptz default now()
activated_at timestamptz
paused_until timestamptz
archived_at timestamptz
```

Constraints:
- CHECK `(SELECT solution_type FROM solutions WHERE id = solution_id) IN ('agent','workflow','bundle')` — enforced via a trigger (postgres CHECK can't reference another table directly). SaaS solutions don't get deployments; they use the existing subscription flow.
- CHECK `(operated_by_org_id IS NULL) OR (operated_by_org_id != client_org_id)` — an agency can't be its own client via a deployment.
- If `operated_by_org_id` is set, an active `client_relationships(agency=operated_by, client=client_org_id, status='active')` row must exist at insert time (trigger). Once created, the deployment continues to exist even if the relationship later pauses/ends — pausing the relationship pauses the deployment (cascade in service layer, not DB, to keep audit clean).
- Indexes: `(client_org_id, status)`, `(operated_by_org_id, status)`, `(solution_id)`.

### 4. RLS — the trust boundary (NON-NEGOTIABLE)
Reuse `is_org_member` from #47.
- **Client org members** read deployments where `client_org_id = ANY(my_org_ids())`. They can pause/archive but cannot change `solution_id`, `operated_by_org_id`, or `runtime_config_override` (those are agency-controlled).
- **Agency org members** read deployments where `operated_by_org_id = ANY(my_org_ids())`. They can mutate `runtime_config_override`, `branding`, `status` (pause/resume). They CANNOT read sibling agencies' deployments. They CANNOT read the client's wallet balance or PII directly — only aggregate usage/outcome metrics (delegated to read functions that strip PII before returning).
- **Vendors** (owner of the underlying solution) get a SECURITY DEFINER read-only RPC `getVendorDeploymentStats(vendor_org_id)` that returns *aggregated counts* (active deployments, runs/month, etc.) **never** including `client_org_id`, `operated_by_org_id`, branding, or runtime overrides. This is the §6/§7 anti-poaching boundary applied to the deployment world.
- **Admins** read everything (existing admin RLS pattern).
- Test file `lib/services/__tests__/deployments-rls.test.ts` proves every boundary (12+ cases: each role × allowed/denied × read/mutate).

### 5. Marketplace-direct deployments (no agency in the loop)
A client may buy an agent/workflow directly from the marketplace without an agency operating it. In that case: `operated_by_org_id = NULL`, `credit_wallet_owner = 'client'`, runtime_config_override may be edited by the client org owner. The deployment is otherwise identical. This keeps the model **uniform** — every agent/workflow run is a deployment, whether agency-operated or self-operated — so #40-#44 don't fork their logic.

### 6. Lifecycle hooks (the service layer, not the DB)
`lib/services/deployments.ts` (new):
- `createDeployment({ solutionId, clientOrgId, operatedByOrgId?, configOverride?, brandingOverride?, walletOwner? })` — validates everything in one place, writes audit_log, fires `deployment.created` event (consumed by #46 analytics + #39 notifications).
- `updateRuntimeConfig(deploymentId, partial)` — merge-patch; validates against the solution's type Zod schema (#49) so a buggy agency override can't poison the runtime. **Invalidates the shared cache** (see below) on success.
- `pauseDeployment(deploymentId, until?)`, `resumeDeployment`, `archiveDeployment` — state machine + audit. Each transition publishes a `deployment.state_changed` event for cache invalidation across servers.
- `getEffectiveConfig(deploymentId)` — returns merge of `solutions.runtime_config` + `solution_deployments.runtime_config_override`. **This is the single function #41 (gateway) and #42 (workflow runner) read at run time** — never read raw rows. **Cached in Upstash Redis** (already in stack since #28) under key `effcfg:v1:{deployment_id}` with 5-minute TTL; explicit invalidation on `updateRuntimeConfig` / `pauseDeployment` / `archiveDeployment` / underlying `solutions.runtime_config` change (fan-out via the deployment list query: `SELECT id FROM solution_deployments WHERE solution_id = $1` then `DEL effcfg:v1:*`). The in-process tier is a 30-second LRU on top of Redis for ultra-hot paths; both tiers MUST be invalidated together. **At 10M deployments × 1000 runs/sec, in-process-only caching would cost ~80% miss rate across 100 servers — Redis is mandatory, not optional.**

### 6b. Hot indexes + sharding seam (load-bearing at 10M+ deployments)
- **Composite indexes** (mandatory):
  - `solution_deployments (client_org_id, status, created_at DESC)` — client portal query (#53).
  - `solution_deployments (operated_by_org_id, status, created_at DESC) WHERE operated_by_org_id IS NOT NULL` — agency dashboard query (#52). Partial index halves storage for marketplace-direct deployments.
  - `solution_deployments (solution_id, status) WHERE status IN ('active','pending_setup')` — vendor aggregate stats (anti-poaching boundary read).
  - `client_relationships (agency_org_id, status, accepted_at DESC) WHERE status = 'active'` — agency client list.
  - All indexes above are created with `CREATE INDEX CONCURRENTLY` per #48 hot-table migration safety.
- **Sharding seam** (declared, not used): `solution_deployments.tenant_shard_id smallint NOT NULL DEFAULT 0`. Indexed as first column of every composite. Future router can shard by `(tenant_shard_id, client_org_id)` without rewriting RLS or queries.
- **No row-level partitioning** on `solution_deployments` itself — it's a "stock" table (active rows, bounded growth per tenant). The flow tables (`usage_events` #40, `deployment_metrics` #51) are partitioned. Keep `solution_deployments` un-partitioned + indexed; revisit only if a single agency exceeds 1M deployments (extreme outlier).

### 6c. Region / data residency seam (declared from day 1)
Add `organizations.region text NOT NULL DEFAULT 'us-east-1'` (or whichever primary region the platform launches in) — values are strings, not an enum, so future regions are config-only. Add `solution_deployments.region text NOT NULL` denormalized from `client_org.region` at insert time (immutable after creation; moving a deployment between regions = archive + recreate). All downstream tables (`usage_events`, `deployment_metrics`, `connector_accounts`) inherit region from the deployment. The single-region launch reads/writes `'us-east-1'`; the router seam in `lib/db/with-region.ts` (stub now, real later) lets `lib/services/*` pick a database connection by region without rewriting any call sites. **Without this column at day 1, splitting EU/US data later means migrating every event table — months of work.**

### 6d. Relationship end / orphan policy (no auto-purge, financial + GDPR safe)
When `client_relationships.status` transitions to `'ended'` (agency drops or client fires), deployments operated by that agency for that client enter a new `'orphaned'` status (extend the deployment status CHECK). Orphaned deployments:
- Stop accepting new runs (gateway/workflow refuses).
- Continue holding their usage_events, audit history, outcome metrics (financial + audit invariants).
- Can be **adopted** by the client (`adoptOrphanedDeployment(deploymentId)` — sets `operated_by_org_id=NULL`, status→`active`, client takes over runtime config), **transferred** to a new agency (if client signs a new `client_relationships`), or **archived** by the client (status→`archived`).
- Auto-archived after 90 days of orphaned status (cron job via #48 jobs queue) — usage_events and outcome metrics stay intact; deployment row is read-only.
- **Never deleted by relationship end** — only by the client's explicit erasure request (#45).

### 7. SaaS continuity — explicit opt-out
SaaS solutions keep using the `subscriptions` table. The marketplace UI for a `solution_type='saas'` still shows "Subscribe" → Stripe Checkout → existing flow. For `solution_type IN ('agent','workflow','bundle')`, the UI shows "Deploy" → goes through `createDeployment`. Same surface, different backend. No deployments are created for SaaS solutions — a CHECK + trigger prevent it.

---

## Acceptance criteria
- [ ] `organization_type` enum extended with `'agency'`, `'client'`; existing rows unchanged.
- [ ] `client_relationships` table created with status enum, partial unique index (one active agency per client), audit on every transition.
- [ ] `solution_deployments` table created; CHECK enforces non-SaaS via trigger; CHECK enforces active relationship at insert when `operated_by_org_id` is set.
- [ ] `agency.ts` service: invite/accept/pause/end client relationships; emits audit + analytics events.
- [ ] `deployments.ts` service: create/update/pause/resume/archive; `getEffectiveConfig` merges base + override; runtime_config validated per `solution_type` (reuses #49 schemas).
- [ ] RLS test suite proves: client reads own deployments, agency reads own clients' deployments, vendor reads aggregate only, no cross-tenant reads.
- [ ] Marketplace-direct deployments work with `operated_by_org_id=NULL` (uniform code path).
- [ ] SaaS solutions cannot get deployments (trigger + test).
- [ ] One active agency per client (partial unique index proven by test inserting a second active row).
- [ ] No table rewrites or AccessExclusiveLock during the migration (verified with `EXPLAIN` + #48 migration safety checklist).
- [ ] `tsc --noEmit` clean; existing tests pass; new tests added for: relationship lifecycle, deployment CRUD, effective-config merge, RLS boundaries.
- [ ] All composite indexes from §6b created with `CREATE INDEX CONCURRENTLY`; `EXPLAIN` proves agency-client-deployment-list query uses index scan (not seq scan) on a 10k-row seeded fixture.
- [ ] `tenant_shard_id` column on `solution_deployments` defaults to 0; indexed as first column of every composite.
- [ ] `organizations.region` + `solution_deployments.region` columns exist; region immutable after insert; `lib/db/with-region.ts` stub created (returns the single connection for now).
- [ ] `getEffectiveConfig` is Redis-cached + in-process-LRU layered; invalidation tested with a multi-server fixture (two test workers, mutate from one, second reads fresh).
- [ ] `'orphaned'` status added; relationship end transitions deployments to orphaned (not auto-purged); adopt/transfer/archive paths covered by tests; 90-day auto-archive job registered.
- [ ] SPEC.md §4 (roles) gains "Agency" and "Client" descriptions; §13 (client ownership) gains a "Deployment" subsection + orphan policy; CLAUDE.md "Folder structure" + "Reseller data model" section reflects the agency/deployment additions.
