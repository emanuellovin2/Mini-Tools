# [PLATFORM] — Build Prompts Index

How to use: open a new Claude Code chat in this project. **Paste the contents of one prompt file at a time**, in order. Each prompt assumes `SPEC.md` and `ENGINEERING.md` are read first. After each one, run its **Verify** step before moving on, and tick it in the `CLAUDE.md` Progress checklist.

Every prompt inherits the **Definition of Done** from `ENGINEERING.md` (strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables).

---

## Phase 0 — Foundation
- [#1 — Project setup, auth, roles, foundations](build_prompts/01-project-setup.md)

## Phase 1 — MVP
- [#2 — Database schema, RLS, anti-poaching boundary](build_prompts/02-database-schema.md)
- [#3 — Public marketplace](build_prompts/03-public-marketplace.md)
- [#4 — Vendor dashboard](build_prompts/04-vendor-dashboard.md)
- [#5 — Stripe Connect onboarding + product/price](build_prompts/05-stripe-connect.md)
- [#6 — Subscribe + webhooks + entitlements](build_prompts/06-subscribe-webhooks-entitlements.md)
- [#7 — Vendor hybrid pricing tiers + monthly cron](build_prompts/07-hybrid-pricing-cron.md)
- [#8 — Anonymous token access](build_prompts/08-anonymous-token-access.md)
- [#9 — Buyer dashboard](build_prompts/09-buyer-dashboard.md)
- [#10 — Admin dashboard](build_prompts/10-admin-dashboard.md)
- [#11 — Testing & security hardening](build_prompts/11-testing-security-hardening.md)
- [#12 — Observability & Stripe↔DB reconciliation](build_prompts/12-observability-reconciliation.md)

## Phase 2
- [#13 — Affiliate role + referral links + 50% split of platform cut](build_prompts/13-affiliate-referrals.md)
- [#14 — Reseller role + $19/mo subscription + storefront offers + 5% platform fee](build_prompts/14-reseller-storefront.md)

## Phase 3 — execute by wave (see `build_prompts/00-EXECUTION-ORDER.md`)

### Wave 1 — Quick wins
- [#20 — Weekly Friday payouts (Stripe Connect payout schedule)](build_prompts/20-weekly-friday-payouts.md)
- [#22 — Reseller 30-day free trial](build_prompts/22-reseller-free-trial.md)

### Wave 2 — Backend pricing (sequential: #15 → #16 → #17)
- [#15 — Vendor 4-tier pricing (12/8/5/3%)](build_prompts/15-vendor-tier-4-levels.md)
- [#16 — Reseller fee from markup (not gross)](build_prompts/16-reseller-fee-from-markup.md)
- [#17 — Net amount basis (after Stripe fees)](build_prompts/17-net-amount-stripe-fees.md)

### Wave 3 — Design system
- [#26 — Design system foundation: tokens, 10 primitives, layout shell, `/buyer` reference page](build_prompts/26-design-system-foundation.md)

### Wave 4 — Affiliate redesign + refund policy (sequential: #18 → #19)
- [#18 — Affiliate model redesign (vendor-funded, active-MRR-tiered)](build_prompts/18-affiliate-model-redesign.md)
- [#19 — Refund vendor-only / dispute all-reverse split policy](build_prompts/19-refund-vendor-only.md)

### Wave 5 — Sticky features (parallel-able within wave)
- [#23 — Subscription pause (`paused_until`, Stripe `pause_collection`)](build_prompts/23-subscription-pause.md)
- [#24 — Vendor analytics (MRR, churn, cohort, LTV)](build_prompts/24-vendor-analytics.md)
- [#25 — Affiliate leaderboard + badges + public profiles](build_prompts/25-affiliate-leaderboard.md)

### Wave 6 — Final docs
- [#21 — Final docs sync (SPEC.md §3/§4/§8/§11, CLAUDE.md, BUILD_PROMPTS.md)](build_prompts/21-docs-sync.md)

## Phase 4 — Wave 7 (sequential: #27 → #28 → #29)
- [#27 — Manual per-vendor commission override](build_prompts/27-manual-vendor-commission-override.md)
- [#28 — Security hardening v2 (CSP, audit log helper, rate limiting)](build_prompts/28-security-hardening-v2.md)
- [#29 — White-label Tier 2](build_prompts/29-white-label-tier-2.md)

## Phase 5 — Wave 8 — UI overhaul + transparency + cross-cutting

Sequential: ship **#30 and #31 first** (both block all dashboards), then **#32–#39 are parallel-able**. **#38** (transparency) is a thin layer woven into each dashboard task; ship the calculator functions early so #32–#35 can consume them.

- [#30 — App screenshots gallery (3–7/app, lightbox, drag-reorder)](build_prompts/30-app-screenshots-gallery.md)
- [#31 — Design system v2 (Stripe-density tokens + primitives + responsive)](build_prompts/31-design-system-v2.md)
- [#32 — Vendor dashboard v2 (channel mix, cash flow, drill-down)](build_prompts/32-vendor-dashboard-v2.md)
- [#33 — Affiliate dashboard v2 (funnel, discover apps, earnings per app)](build_prompts/33-affiliate-dashboard-v2.md)
- [#34 — Reseller dashboard v2 (browse apps, per-offer analytics, alerts)](build_prompts/34-reseller-dashboard-v2.md)
- [#35 — Buyer dashboard v2 (calendar, payment methods, invoices, privacy)](build_prompts/35-buyer-dashboard-v2.md)
- [#36 — Admin dashboard v2 (system health, drill-downs, support tools)](build_prompts/36-admin-dashboard-v2.md)
- [#37 — Marketplace v2 (search, filters, sort, categories)](build_prompts/37-marketplace-v2.md)
- [#38 — Fee transparency layer (live calculators + `/legal/fees` page)](build_prompts/38-fee-transparency-layer.md)
- [#39 — Cross-role: notifications, account settings, onboarding, CSV, vendor webhooks](build_prompts/39-cross-role-notifications-accounts.md)

## Phase 6 — Wave 9 — Stripe + Shopify for AI agencies

The pivot from "marketplace of SaaS" to **"infrastructure agencies use to build agent-powered businesses for SMB clients."** Designed around **BYOK + prepaid credits = zero/minimal compute cost to the platform**, the **agency↔client relationship** as the primary unit of operation, and **deployments** (not subscriptions) as the operational instance for agents/workflows. Vendor/reseller/affiliate roles continue to earn — agencies are the new high-LTV operator role on top.

**Execution order — foundation first, then refit existing kitchens, then surfaces:**

```
#49 Solutions abstraction  →  #50 Agency+Deployments  →  #51 Outcomes (parallel)
                                     ↓
       #40 (refit) → #41 → #42 → #43 → #44 (refit)
                                     ↓
                           #52 Agency dash  +  #53 Client portal
                                     ↓
                                    #45 DPA
```

**Foundation (build first — schema seams that block everything else):**
- [#49 — Solutions abstraction (apps → typed solutions)](build_prompts/49-solutions-abstraction.md) — `saas | agent | workflow | bundle` types, runtime_config, templates, version retention, sharding seam, search abstraction declared. **BLOCKS #50–#53, reshapes #40–#44.**
- [#50 — Agency ↔ Client relationships + Solution deployments](build_prompts/50-agency-client-deployments.md) — `org.type='agency'|'client'`, `client_relationships`, `solution_deployments` as the new operational unit; region column + sharding seam + Redis-cached effective config + orphaned status. **BLOCKS #51–#53, refits #40–#44.**
- [#51 — Outcome metrics seam (deployment ROI proof)](build_prompts/51-outcome-metrics.md) — daily-partitioned time-series KPIs, cardinality budget, async-default at high volume, incremental rollup with watermark, cold-storage seam. Parallel-able with #40.
- [#54 — Wave 9 scale invariants & operational seams](build_prompts/54-scale-invariants.md) — search abstraction, read-replica + region routing, settlement batching, OAuth refresh stampede mitigation, hot-wallet sharding seam, idempotency dedupe table, custom-domain SSL strategy. **Cross-cutting — declared seams that #40–#53 consume.**

**Usage economy (refit to deployments as they're built):**
- [#40 — Usage metering ledger + usage-based billing (the meter)](build_prompts/40-usage-metering-billing.md) — refit: `usage_events.deployment_id`; splits via deployment's `(vendor, agency, platform)`. **BLOCKS #41–#44**
- [#41 — AI Gateway (BYOK) (the door)](build_prompts/41-ai-gateway-byok.md) — refit: keys per-deployment (vendor/agency/client BYOK), per-deployment spend caps
- [#42 — Workflow / automation engine (the recipe book)](build_prompts/42-workflow-engine.md) — refit: runs scoped to deployments
- [#43 — Connectors / integrations (the lock-in)](build_prompts/43-connectors.md) — refit: OAuth owned by client_org, delegated to deployment
- [#44 — Usage-product distribution + solution templates](build_prompts/44-usage-product-distribution.md) — refit: agency forks vendor templates, customises, deploys

**Agency + client surfaces:**
- [#52 — Agency operations dashboard](build_prompts/52-agency-operations-dashboard.md) — client-centric (N managed clients), health board, drill-down drawer, agency billing
- [#53 — Client portal (WL-branded SMB-facing UI)](build_prompts/53-client-portal.md) — SMB sees own deployments + outcomes + billing under agency brand; subdomain WL; replaces buyer dashboard for agency-operated clients

**Legal:**
- [#45 — Partner-client data lifecycle & DPA](build_prompts/45-partner-client-data-lifecycle.md) — `partner_clients`, export/erasure across deployments, retention, `/legal/dpa`. Depends on #40/#41/#43/#50.
