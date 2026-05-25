# Task #52 — Agency operations dashboard

> **Before starting:** read [build_prompts/50-agency-client-deployments.md](build_prompts/50-agency-client-deployments.md), [build_prompts/51-outcome-metrics.md](build_prompts/51-outcome-metrics.md), [app/reseller/](app/reseller/) (existing reseller dashboard — different shape), [components/layout/DashboardShell.tsx](components/layout/DashboardShell.tsx), [build_prompts/31-design-system-v2.md](build_prompts/31-design-system-v2.md).
> **Definition of Done:** `/agency` route — first dashboard built around "I operate N clients" instead of "I sell M offers." Lists clients with health signals, drills into per-client deployment view, surfaces churn risk + expiring connectors + low-credits + ROI delivered. **Reuses the reseller layout pattern + design system v2 primitives**; zero new primitives required.

**Phase 6 — Wave 9. Depends on: #50 (deployments), #51 (outcome metrics), #43 (connectors — soft dependency: health flags read connector status if present, work without it). Builds in parallel with #53. After this and #53, agencies have a complete operational surface.**

> **Why this is not the reseller dashboard:** reseller dashboard is **offer-centric** (one offer × many anonymous buyers, no PII allowed). Agency dashboard is **client-centric** (one client = one organisation the agency knows by name, has talked to, configures for). Different mental model, different RLS scope, different primary list view. Same primitives, different information architecture.

---

## Sections to build

### 1. `/agency` route + layout
- `app/agency/layout.tsx` — Server Component wrapping `DashboardShell`. Role-checks `org.type='agency'`; non-agency users hitting `/agency` get redirected to their role's dashboard (existing pattern in #31).
- Sidebar entries: **Overview**, **Clients**, **Solutions** (the agency's forked/customised templates — links to #44), **Billing** (agency's own platform billing, payouts), **Settings**.
- Topbar shows active-agency-org switcher (a user can own/operate multiple agencies — reuses #47 org switcher).

### 2. Overview page (`/agency`)
KPI strip (uses `KpiCard` from #31):
- **Active clients** (count + delta vs last 30d).
- **Total deployments active** (sum across clients).
- **MRR being operated** (sum of all client-paid prepaid topups attributed to deployments operated by this agency, rolling 30d).
- **Agency take** (sum of agency-share splits from #40 `usage_events`, rolling 30d).
- **Outcomes delivered** (top 3 metrics across all clients — read from `getAgencyOutcomeSummary`, e.g. "1,247 leads · 318 meetings · $42k saved").

Below KPIs:
- **Health board** (uses `DenseTable`): one row per client, columns: client name, deployments active, last activity, credit balance band (low/ok/high — no exact $$ to avoid normalising "looking at client wallet"), pending alerts (red dot if any). Sorted by alert severity, then last activity.
- **Activity feed** (uses existing notifications/audit pattern): last 20 deployment state changes, OAuth expirations, low-credit warnings — agency-scoped (RLS).

### 3. Clients list (`/agency/clients`)
- `DenseTable` with: client org name, agency relationship status (active/paused/invited/ended), # deployments, MRR, last outcome emit, churn risk score (computed: weighted of recency-decline + credit-balance-low + outcome-trend-down, returned by a service function — pure, tested).
- Row click → drawer (`Drawer` from #31) showing client detail. Drawer is non-blocking; the table stays interactive.
- Toolbar: invite client button (modal → `inviteClient` from #50), filter by status, search by name.

### 4. Client drawer (drilldown without page change)
Sections inside the drawer:
- **Overview**: relationship status, since-date, total revenue from this client, total outcomes delivered (top 3 metrics).
- **Deployments**: list of `solution_deployments` for this client where `operated_by_org_id = current agency`. Each row: solution name, status, runtime config diff badge (if override differs from base — clickable to show diff), credit wallet pointer (client vs agency), last run, last outcome. Inline actions: pause/resume, edit runtime config, archive.
- **Connectors** (when #43 ships — shown empty/disabled until then): OAuth accounts the client has granted to deployments this agency operates. Status, expiry, scope. Cannot read tokens; can only request re-grant.
- **Outcomes**: time-series chart (uses `Sparkline` from #31 for compact; click-through to full chart page) of top 5 metrics for this client, comparing last-30d vs prior-30d. Reads `getClientOutcomeSummary`.
- **Activity log**: client-scoped audit log entries (RLS-filtered).

### 5. Solutions page (`/agency/solutions`)
The agency's catalog of *operatable* solutions:
- **Forks**: solutions where `solutions.org_id = current agency org` (created/customised by this agency, including forks of vendor templates via #44).
- **Templates available**: solutions where `is_template=true AND status='active'` (vendor-published templates the agency can fork). One-click "Fork & customise" CTA → creates a new agency-owned solution row with `template_of_id` set, opens it for editing.
- Deferred until #44 ships the fork flow — for now, show only forks the agency already owns. Page renders empty-state with a "Coming soon" callout if no forks yet.

### 6. Billing page (`/agency/billing`)
Agency's *own* money view (separate from clients' money):
- Stripe Connect balance (agency receives transfers from #40 splits).
- Payout schedule (Friday weekly per #20).
- Lifetime + 30d earnings from operating clients.
- Lifetime + 30d earnings from solution forks bought by other agencies (#44 future).
- CSV export (reuses #39 CSV export infra).

### 7. Service layer (`lib/services/agency-dashboard.ts`)
```ts
getAgencyOverviewKpis(agencyOrgId, days=30): { activeClients, deployments, mrrCents, agencyTakeCents, topOutcomes }
getAgencyHealthBoard(agencyOrgId, cursor?): { clients: [...], nextCursor?: string }
getAgencyClients(agencyOrgId, filter, cursor?): { rows: [...], nextCursor?: string }   // NO offset; cursor pagination only
getClientDetail(agencyOrgId, clientOrgId): { relationship, deploymentsFirstPage, outcomes, connectors? }
getClientDeployments(agencyOrgId, clientOrgId, cursor?): { rows: [...], nextCursor?: string }  // separate call, drawer lazy-loads
computeChurnRisk(args): number  // pure, tested — 0..1
```
- **Cursor pagination only** (no `OFFSET` — at 100k+ clients/agency, OFFSET full-scans every preceding row). Cursor format: opaque base64 of `(last_seen_value, last_seen_id)` where the value is whatever sort column drives the query (last activity, churn score, name). Stable across inserts/deletes.
- **All reads RLS-gated server-side**; route handlers double-check `is_org_member(agencyOrgId, ['owner','admin','member'])`.

### 7b. Precomputed health (cron-updated, not live)
- New table `client_health_scores`: `(agency_org_id, client_org_id, computed_at, alert_count, alert_severity smallint, churn_risk numeric(4,3), balance_band text, last_activity_at)`. UNIQUE on `(agency_org_id, client_org_id)`.
- Updated by `agency-health-cron` (every hour) via #48 jobs queue: one job per active agency. Worker reads its clients' deployments + wallets + relationship status + recent outcomes + recent runs + connector expiries, computes alerts + churn score, upserts the row.
- **Why precomputed**: at 1M-client agencies, computing health live on dashboard load = 1M sub-queries per request. Precomputed = single index scan on `(agency_org_id, alert_severity DESC, last_activity_at DESC)`.
- Health-board UI shows the precomputed row's `computed_at` so users know if the data is stale; "Refresh now" button enqueues an on-demand job for that specific agency (rate-limited 1/min/agency to prevent abuse).
- Index: `client_health_scores (agency_org_id, alert_severity DESC, last_activity_at DESC) INCLUDE (client_org_id, alert_count, churn_risk, balance_band)` — index-only scans serve the dashboard query without touching the table.

### 8. Empty states + onboarding
- Zero clients: empty state explaining "Invite your first client" with a CTA + a 4-step checklist (uses `OnboardingChecklist` from #31): invite → accept → first deployment → first outcome emit.
- Zero deployments per client: drawer empty state with "Deploy a solution" CTA (deferred to #44/#41/#42 when those flows land — for now, link to the solutions page).

### 9. Mobile
The `DashboardShell` (#31) already does the sidebar drawer at <768px. Verify the agency dashboard works there:
- Drawer for client detail uses full-screen takeover on mobile (existing `Drawer` behaviour).
- `DenseTable` collapses to card-list rows below 640px (existing primitive behaviour).

---

## Acceptance criteria
- [ ] `/agency` accessible only to members of an `org.type='agency'` org; non-agency users redirected.
- [ ] Overview KPIs render real numbers from real services; no placeholder data.
- [ ] Health board sorts by alert severity then activity; alerts come from real signal sources (low credit, paused deployment, ended relationship — not stubbed).
- [ ] Clients list shows accurate counts and statuses; relationship lifecycle actions (invite/pause/end) work end-to-end with #50 service layer.
- [ ] Client drawer shows deployment list with runtime-config diff badges (read from `getEffectiveConfig` vs base); inline pause/resume/edit work.
- [ ] Outcomes section pulls from `getClientOutcomeSummary` (#51); shows empty state if no metrics emitted yet.
- [ ] Billing page shows Stripe Connect balance + payout schedule (reuses existing reseller balance widgets where applicable).
- [ ] `computeChurnRisk` is pure + has unit tests covering recency decline, credit-balance-low, outcome-trend-down weights.
- [ ] RLS proven: agency A cannot read agency B's clients, even with crafted IDs (test).
- [ ] Mobile renders without horizontal scroll; drawer is full-screen on <640px.
- [ ] No new design-system primitives added; reuses `KpiCard`, `DenseTable`, `Drawer`, `Sparkline`, `EmptyState`, `OnboardingChecklist`, `Toast`, `Badge` from #31.
- [ ] **Cursor pagination** on every list endpoint (no `OFFSET`); k6 smoke proves p95 < 100ms on a 100k-client agency fixture.
- [ ] `client_health_scores` table populated by hourly cron; dashboard reads precomputed values; manual refresh rate-limited.
- [ ] Health-board query uses index-only scan (verified by `EXPLAIN`).
- [ ] CLAUDE.md "Folder structure" updated; SPEC.md §4 (roles) gains "Agency dashboard" subsection.
