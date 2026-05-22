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
