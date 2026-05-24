# Task #53 — Client portal (WL-branded SMB-facing UI)

> **Before starting:** read [build_prompts/50-agency-client-deployments.md](build_prompts/50-agency-client-deployments.md), [build_prompts/51-outcome-metrics.md](build_prompts/51-outcome-metrics.md), [build_prompts/29-white-label-tier-2.md](build_prompts/29-white-label-tier-2.md) (subdomain WL pattern + proxy.ts), [build_prompts/35-buyer-dashboard-v2.md](build_prompts/35-buyer-dashboard-v2.md) (existing buyer dashboard — different role), [app/_wl/](app/_wl/).
> **Definition of Done:** `/client` route + per-client subdomain WL surface where an SMB sees their own deployments, usage, outcomes, billing — under the agency's brand, with **zero platform attribution** except a small "Hosted by [PLATFORM]" legal footer. Replaces the buyer dashboard for clients of agencies; existing buyer dashboard (#35) remains for direct marketplace buyers.

**Phase 6 — Wave 9. Depends on: #50 (deployments), #51 (outcomes), #29 (WL subdomain + branding patterns), #40 (credit wallets). Builds in parallel with #52.**

> **Why a separate portal:** the existing buyer dashboard (#35) is built for *marketplace buyers* — anonymous to vendors, branded as the platform, oriented around "manage my Stripe subscriptions." The client portal is for *operated SMBs* — known to the agency, branded as the agency, oriented around "see what my agency-operated agents are doing for me." Different mental model, different branding rules, different RLS surface. Same primitives, different shell.

> **Anti-poaching invariant (carried from §6/§7):** the client never sees the vendor's identity for an agency-operated deployment. The "solution" is presented under the agency's brand. The "Hosted by" footer points to the platform, NOT the vendor. Vendor identity is exposed only on marketplace-direct deployments where the SMB self-served.

---

## Sections to build

### 1. Routing surface — two access paths, one portal
- **Subdomain WL** (preferred for agency-operated clients): `<agency-slug>.<base>` → rewrites via `proxy.ts` to `/_client/<agency-slug>/`. Reuses the existing #29 subdomain rewrite logic; add `_client` rewrite target alongside `_wl`. The agency's `clients.<agency-slug>.<base>` variant is **out of scope** — keep ONE subdomain per agency for now; the client portal is served under the same subdomain the WL storefront uses, with auth-gated routes.
- **Canonical path** (fallback / direct link): `/client` on the base domain works too, with the agency brand applied via a session value (the user's active client_org → relationship's agency → branding).
- **Authenticated only**: unauthenticated visits to `/client` or `/_client/...` redirect to login. After login, if the user is a member of multiple client orgs (rare but supported), the topbar shows a switcher (reuses #47 org switcher).
- **Marketplace-direct deployments** (where `operated_by_org_id IS NULL`) appear in the SAME client portal under the *platform* brand — no agency to wrap them. This handles the hybrid case: an SMB has agency-operated agents AND a self-served one, all in one place.

### 2. Branding resolution (the WL layer — cached, not live-queried per request)
- **Branding lives on `organizations`**, not `profiles` (migration in this task: move `wl_global_*` columns from `profiles` to `organizations`, leave a temporary view for backward compat with #29 storefront code; drop the view in #21 docs-sync after audit). Future agency-only data hangs off org rows uniformly.
- For each authenticated request, resolve effective branding:
  - If user's active client_org has an active `client_relationships` with an agency → use the agency org's `wl_global_logo_url / wl_global_brand_color / wl_global_display_name`.
  - If no active agency relationship → platform default branding.
- **Caching strategy** (load-bearing at 10M+ users):
  - On session start (login / org switch), the effective branding payload is computed once and stamped into a **signed session cookie** (`client_branding_v1`, max-age 1h, signed with the existing session secret). All page renders read the cookie — zero extra DB query per request.
  - When an agency mutates its branding, a `branding.changed` event flips a Redis key `branding_version:{agency_org_id}`. Each request compares its cookie version vs Redis; mismatch → refresh from DB and re-stamp.
  - Without this caching: at 10M users × 100 req/min = ~16M req/sec hitting `organizations` + `client_relationships` joins just for theme colors. Unacceptable.
- Branding is applied to: logo (topbar + favicon hint), primary color (CSS var override on the layout root), display name (page title, email "From" address for client emails — reuses #12 email pattern).
- **"Hosted by [PLATFORM]" legal footer**: small (12px), bottom-of-page, links to `/legal/dpa` (#45). Required on every client portal page. Per CLAUDE.md anti-poaching guardrail.
- **Subdomain SSL strategy** — at >1k agency subdomains, Vercel's built-in wildcard cert won't cover *.platform.com if agencies bring their own domains (`portal.acme-agency.com`). Decision deferred to #54 §5 (Cloudflare for SaaS vs Vercel custom domain + ACME automation). Until that ships, agencies are restricted to platform-issued subdomains under the wildcard (`<agency-slug>.platform.com`). Custom-domain BYOD is gated behind a feature flag.

### 3. Overview page (`/client`)
KPI strip (uses `KpiCard` from #31):
- **Active solutions** (count of `solution_deployments` with status='active', scoped to client_org).
- **Credit balance** (from `credit_wallets`, formatted in client's currency).
- **Outcomes delivered this month** (top 3 metrics from `getClientOutcomeSummary`).
- **Next billing date** (next prepaid top-up reminder if auto-topup enabled, or wallet runway estimate based on 7d trailing drawdown rate).

Below:
- **Deployments grid**: cards (uses `Card` primitive), one per active deployment. Each shows: solution display name (agency-customised, NOT vendor's), status badge, last activity, mini-sparkline of primary outcome metric, "Open" CTA.
- **Recent activity** (last 10 deployment events + outcome emits, plain-English formatted: "Sales SDR agent booked 3 meetings yesterday").

### 4. Deployment detail (`/client/deployments/[id]`)
- **Header**: display name, status, agency contact (link to email — agency-controlled, NOT vendor PII).
- **Outcomes panel**: full-size charts of every metric this deployment emits, with comparison ranges (7d/30d/90d). Reads `deployment_metrics_rollup` (#51).
- **Usage panel**: credit consumption over time, current month-to-date spend, drawdown rate. Reads `usage_events` aggregates scoped to deployment.
- **Connectors panel** (when #43 ships): OAuth accounts this client has granted to this deployment. Client can revoke (cascades to deployment pause via service layer). Client cannot see tokens or grant on behalf of other deployments.
- **Settings panel** (limited): pause/resume deployment, request changes (opens a thread to the agency — reuses #39 notifications), end deployment (confirmation modal — ends the deployment but client_relationships is untouched; ending the relationship is a separate flow).
- **Privacy panel**: what data this deployment can access (derived from connector scopes + runtime config — read-only audit), data retention, export own data, request deletion (kicks off #45 erasure job).

### 5. Billing (`/client/billing`)
- Credit wallet balance + auto-topup toggle (reuses #40 wallet UI).
- Top-up history (uses `DenseTable`).
- Per-deployment drawdown breakdown (lets the client see "Sales agent: $230 this month; Support agent: $90").
- Invoice/receipt history (existing receipt email path #12, listed here for self-serve download).
- Payment methods (reuses Stripe Customer Portal redirect; minimal in-app).

### 6. Privacy / data (`/client/privacy`)
The DPA seam (#45):
- "Your data" section: list of connector accounts, deployments accessing them, retention policy per data type.
- "Export" button → enqueues an export job (#48 jobs queue, handler from #45).
- "Delete" button → enqueues erasure job (also #45). Confirmation + 7-day cool-off (cancelable).
- "Data processing agreement" link → `/legal/dpa`.
- Audit log of access events (client can see when the agency or vendor read data, via #46 events scoped to deployment).

### 7. Service layer (`lib/services/client-portal.ts`)
```ts
getClientOverview(clientOrgId): { kpis, deployments[], recentActivity[] }
getClientDeploymentDetail(clientOrgId, deploymentId): { ...full payload }
listClientInvoices(clientOrgId, range): Invoice[]
requestDeploymentChange(deploymentId, message): { ok }  // creates a thread to the operating agency
revokeConnector(connectorAccountId): { ok, pausedDeploymentIds }
```
All RLS-gated; double-checked via `is_org_member(clientOrgId)` server-side.

### 8. Emails — agency-branded (sent via #48 jobs queue, never synchronous)
**All client-portal emails go through `lib/jobs/queue.ts` with job type `client_email`** — never call Resend directly from a request handler. At 10M clients × 5 emails/week = ~7 emails/sec sustained; Resend rate limits + transient failures + retries mean synchronous sends will time out request handlers. The job worker handles batching, retry with exponential backoff, suppression list checks, and per-agency rate limiting (default 100 emails/min/agency, configurable via `org_quotas`).

When the client receives:
- Outcome digest (weekly): "Your [Agency] solutions delivered X this week"
- Low-credit warning
- Deployment paused / resumed
- Connector expiring
- Receipt for top-up

… the From name is the agency's `wl_global_display_name`, reply-to is the agency's primary contact email, and the body uses agency branding. The platform's email infrastructure (Resend via #12) sends them but never imprints "[PLATFORM]" branding. Footer: small "Sent on behalf of [Agency] via [Platform]" line + DPA link (legal requirement, not marketing).

### 9. Marketplace-direct (no agency) variant
If the client portal user has a `solution_deployments` row with `operated_by_org_id IS NULL`, that deployment shows under platform branding within the same portal. The deployment card includes a "Self-managed" badge to distinguish. Settings panel for self-managed deployments allows full runtime config editing (vs agency-managed where edits go through `requestDeploymentChange`).

---

## Acceptance criteria
- [ ] `/client` route gated to client_org members; non-members redirected.
- [ ] Subdomain `<agency-slug>.<base>/client/...` rewrites correctly via `proxy.ts`; auth-gated; preserves agency branding across SSR + client navigation.
- [ ] Branding resolution: agency-operated deployment → agency brand; marketplace-direct → platform brand; mixed portal handles both side-by-side without bleed.
- [ ] "Hosted by [PLATFORM]" legal footer present on every client-portal page; small (12px), bottom; DPA link works (deferred to #45 — link to `/legal/fees` as placeholder until then).
- [ ] Deployment cards show agency-customised display name, NEVER vendor identity, for agency-operated deployments.
- [ ] Outcome charts pull from `deployment_metrics_rollup` (#51); empty states when no metrics emitted.
- [ ] Credit wallet shows accurate balance + drawdown rate; top-up flow works via Stripe Checkout (#40).
- [ ] `requestDeploymentChange` creates an in-app notification + email to the agency operator (reuses #39 notifications).
- [ ] `revokeConnector` cascades to pause affected deployments; client sees the pause + reason.
- [ ] Privacy panel: export + erasure buttons enqueue jobs to the #48/#45 pipeline; audit log of data access visible.
- [ ] Emails are agency-branded (From name, brand color) for agency-operated clients; platform-branded for marketplace-direct.
- [ ] No vendor PII or identity exposed to client for agency-operated deployments (RLS-tested).
- [ ] Mobile renders correctly (uses #31 responsive primitives); no horizontal scroll.
- [ ] Branding migrated from `profiles` to `organizations`; legacy view temporarily aliases for #29 storefront continuity.
- [ ] Branding cached in signed session cookie (1h max-age); version compared against Redis `branding_version:*` keys on each request; cache miss → re-stamp.
- [ ] All transactional emails enqueued via #48 jobs queue (job type `client_email`); per-agency rate limit enforced via `org_quotas`.
- [ ] Custom-domain BYOD feature-flagged off; platform-subdomain WL works under existing wildcard.
- [ ] CLAUDE.md "Folder structure" updated to include `app/client/` and `app/_client/`; SPEC.md §4 (roles) gains "Client (SMB)" subsection; §13 (client ownership) clarifies the portal's branding rules.
