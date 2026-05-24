# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# [PLATFORM]

A multi-sided marketplace where developers list SaaS apps and sell them on subscription; affiliates bring users via referral links; resellers run their own storefronts with markup over a vendor-set floor. The platform owns billing, access, and distribution.

**Economics at a glance:**
- **Vendor (direct sale):** platform takes 12%/8%/5%/3% by trailing monthly net tier ($0–$1k / $1k–$3k / $3k–$10k / $10k+). Computed on net amount (after Stripe fees). **No flat fee.**
- **Affiliate (referral):** vendor sets `affiliate_commission_bps` per app (20–80%). On affiliate sales: platform takes **5% of net**, affiliate gets their set %, vendor keeps the rest. Affiliate tier: 20%/25%/30% at $0/$5k/$20k active MRR generated. Commission snapshotted at subscribe time — tier changes only affect new subs.
- **Reseller (storefront):** pays **$19/month** for platform access (30-day free trial). On each sale: vendor gets `min_price` floor, platform takes **5% of the markup** (not gross), reseller keeps the rest.

## Commands (available after #1 bootstraps the project)
```bash
npm run dev          # Next.js dev server
npm run typecheck    # tsc --noEmit (strict)
npm test             # Vitest (all tests)
npm test -- --run <path>   # run a single test file
npm run types        # supabase gen types typescript --local > types/supabase.ts
supabase start       # local Supabase stack (Postgres + Auth + Studio)
supabase stop        # stop local stack
supabase db push     # apply migrations to local stack
stripe listen --forward-to localhost:3000/api/webhooks   # forward webhooks in dev (required from #5)
```

## Read these first
1. **`SPEC.md`** — the source of truth. Architecture, roles, pricing, schema, business rules. Read it in full before writing any code.
2. **`BUILD_PROMPTS.md`** — index of the ordered build plan. Each prompt lives as its own file in `build_prompts/`. For tasks #15–#26 read `build_prompts/00-EXECUTION-ORDER.md` first — execution is by wave, not by task number.
3. **`ENGINEERING.md`** — engineering principles. Every prompt must follow them (money as cents + bps, Separate Charges & Transfers, idempotent webhooks, RLS + RLS tests, strict TS, tests on critical paths). Read before writing code.

## Folder structure (established in #1–#26)
```
lib/
  logger.ts          # structured JSON logger — logWebhookEvent, logMoneyFlow, logAccessEvent, logEmail (no PII/secrets)
  services/
    __tests__/       # RLS policy tests (rls.test.ts, rls-extra.test.ts) + vendor.test.ts
    apps.ts          # app CRUD + listing queries
    vendor.ts        # vendor-scoped data access
    buyer.ts         # getBuyerSubscriptions() — joins subscriptions + apps for the dashboard
    admin.ts         # getPlatformStats, getPendingApps, getVendors, getAllSubscriptions, getAuditLog, getChurnAlerts, dispatchChurnAlerts, getVendorsWithCutInfo, setVendorCutOverride, writeAuditLog
    affiliate.ts     # createAffiliateLink, getAffiliateLinks, validateAffiliateCode, getAffiliateStats, recordAttribution; getLeaderboard, getAffiliatePublicProfile, getEarnedBadges, getBadgeProgress, updateAffiliateProfile, computeEarnedBadgeIds (pure)
    reseller.ts      # createOffer, getOffers, getStorefrontOffer, upsertResellerSubscription, pauseOffersOnLapse, getResellerDashboard
    reconciliation.ts  # runReconciliation(), getReconciliationRuns() — Stripe↔DB drift detection
    supabase.ts      # Supabase admin client (service role)
    supabase-server.ts  # Supabase server client (cookie-based session)
    supabase-browser.ts # Supabase browser client
  stripe/
    __tests__/       # Stripe helper tests (incl. affiliate.test.ts, reseller.test.ts — money math)
    anon-user.ts     # anonymous user token helpers
    billing.ts       # computeTier() pure function — 4 tiers: 1200/800/500/300 bps at $0/$1k/$3k/$10k net
    client.ts        # Stripe SDK singleton
    connect.ts       # Connect onboarding helpers (vendor + affiliate + reseller)
    customers.ts     # Stripe Customer helpers
    entitlements.ts  # stripeStatusToSubscriptionStatus()
    products.ts      # product/price helpers
    transfers.ts     # transferVendorShare(), transferAffiliateShare(), computeResellerSplit(), transferResellerVendorFloor(), transferResellerShare(), reverseTransfers(), getVendorCutBps()
    webhook-handlers.ts  # all Stripe event handlers (+ structured logging, receipt/dunning emails)
  email/
    resend.ts        # sendSubscriptionReceipt, sendPaymentFailedNotice, sendChurnAlert, sendReconciliationDigest — all degrade gracefully on Resend outage
  auth/              # JWT mint/verify logic
  validation/
    env.ts           # boot-time Zod env validation
    vendor.ts        # vendor input schemas
    reseller.ts      # reseller slug + offer schemas
  utils/
    magic-bytes.ts   # file type detection by magic bytes (upload validation)
    rate-limit.ts    # simple in-memory rate limiter for API routes
app/
  vendor/            # vendor dashboard pages + actions (incl. min_price_cents toggle, analytics: MRR, churn, cohort, LTV)
  marketplace/       # public browse pages
  api/
    webhooks/        # Stripe webhook endpoint (raw body, signature-verified, structured logging)
    stripe/          # Connect onboarding + product sync routes
    admin/           # admin approve-app route
    affiliate/
      links/         # POST /api/affiliate/links — generates 8-char base62 code
      onboard/       # GET /api/affiliate/onboard — redirects to Stripe Connect Express onboarding
    reseller/
      setup/         # POST /api/reseller/setup — create Stripe Checkout for $19/mo plan
      checkout/      # POST /api/reseller/checkout — create Checkout for buyer buying via reseller offer
      connect/       # GET /api/reseller/connect — redirect to Stripe Connect Express onboarding
    well-known/      # JWKS endpoint
  buyer/
    page.tsx             # buyer dashboard: subscription list, Launch, cancel-at-period-end, pause
    actions.ts           # cancelSubscriptionAction, pauseSubscriptionAction (Server Actions)
    _components/
      CancelButton.tsx   # client component — confirm dialog + useTransition
      PauseButton.tsx    # pause/resume toggle — Stripe pause_collection + paused_until
  affiliate/
    page.tsx             # affiliate dashboard: Connect onboarding, generate links, aggregate stats, rank, badge progress (no buyer PII)
    actions.ts           # createAffiliateLinkAction (Server Action)
    _components/
      GenerateLinkForm.tsx
      LinksList.tsx
  affiliates/            # public-facing (no auth required)
    top/
      page.tsx           # public leaderboard — top 50 affiliates by active/lifetime MRR (rounded)
    [slug]/
      page.tsx           # public affiliate profile — badges, rounded stats, top apps, no PII
  reseller/
    setup/
      page.tsx         # slug entry + Start $19/mo subscription CTA
    offers/
      page.tsx         # list existing offers + create-offer form
      _components/
        CreateOfferForm.tsx
    page.tsx           # reseller dashboard: billing status, Connect status, MRR by offer, lifetime payouts
    actions.ts         # createOfferAction, updateOfferStatusAction
  r/
    [reseller-slug]/
      [offer-slug]/
        page.tsx       # public storefront: app info + offer price + Subscribe button
  admin/
    page.tsx             # admin dashboard: stats, approvals, vendors, subscriptions, audit log, churn
    actions.ts           # approveAppAction, rejectAppAction, syncVendorStripeAction
    reconciliation/
      page.tsx           # reconciliation run list + drift item detail view
    _components/
      ApproveRejectButtons.tsx
      SyncStripeButton.tsx
components/
  ui/               # shadcn-style primitives: Button, Card, Input, Select, Label, Badge, Modal, Toast, Table, Skeleton
  layout/           # DashboardShell, Sidebar, Topbar, PageHeader — opt-in wrapper for dashboard pages
next.config.ts       # security headers (CSP report-only, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP, CORP)
proxy.ts             # Next.js middleware: auth enforcement, role routing, ?aff= cookie capture (30d HTTP-only)
supabase/
  migrations/        # all schema changes — never manual dashboard edits
  functions/
    monthly-billing-cron/     # Edge Function: 0 1 1 * * — writes vendor_billing rows (excludes reseller-sold via is_reseller_sale flag)
    daily-reconciliation-cron/ # Edge Function: 0 2 * * * — Stripe↔DB checks + Resend digest
types/
  supabase.ts        # auto-generated from `npm run types` — never hand-edit
scripts/
  set-weekly-payouts.ts   # one-shot: configure weekly Friday payout schedule on all connected accounts
```

## Affiliate data model (as of #25)
- `profiles.affiliate_active_mrr_cents` — current active MRR (drives commission tier + leaderboard rank). Set by `increment_affiliate_mrr` RPC on `invoice.paid`; decremented on refund.
- `profiles.affiliate_lifetime_mrr_cents` — monotonic cumulative MRR (drives lifetime badges). Decremented on refund to keep badges honest.
- `profiles.slug` — shared between affiliates and resellers; UNIQUE globally. NULL = opted out of public profile (affiliate hides from `/affiliates/top` and their `/affiliates/<slug>` returns 404).
- `affiliate_badges` — static lookup table; badges are **derived** via `affiliate_earned_badges(p_affiliate_id)` RPC, not stored per-affiliate.
- `affiliate_leaderboard` — public view; excludes profiles where `slug IS NULL` or `affiliate_lifetime_mrr_cents = 0`.
- Public MRR display must be **rounded** (to nearest $100 or banded) — exact figures let competitors back-calculate subscriber counts.

## How to work in this repo
- Build one numbered prompt at a time. Do not jump ahead.
- After finishing a prompt, tick it in the **Progress** checklist below.
- Keep `[PLATFORM]` as a placeholder until a real name is chosen, then find-replace across all files.
- Tech stack (do not swap without reason): Next.js (App Router, TS), Supabase, Vercel, Stripe Connect, Resend, JWT RS256.

## Environment variables (set in `.env.local`, never commit)
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_APP_URL=                   # e.g. http://localhost:3000 — Stripe return_url, JWKS URL, email links, redirects
STRIPE_SECRET_KEY=                     # required from #5
STRIPE_WEBHOOK_SECRET=                 # required from #6 — in dev use the value `stripe listen --print-secret` returns
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=    # required from #5
RESEND_API_KEY=                        # required from #12 — transactional email + admin alerts
ADMIN_EMAIL=                           # required from #12 — recipient for churn alerts and reconciliation digest
EMAIL_FROM=                            # optional — defaults to noreply@platform.local
JWT_PRIVATE_KEY=                       # RS256 private key (PEM, newlines escaped as \n)
JWT_PUBLIC_KEY=                        # RS256 public key (PEM); served via /.well-known/jwks.json
JWT_KEY_ID=                            # `kid` for the active key, so keys can rotate without breaking vendors
CHURN_ALERT_THRESHOLD_BPS=2000         # 20% — vendor monthly cancellation rate above this is flagged in #10
STRIPE_RESELLER_PLAN_PRICE_ID=         # required from #14 — Stripe Price id (recurring $19/mo, USD) the reseller subscribes to on the platform account
UPSTASH_REDIS_REST_URL=               # required from #28 in production — distributed rate limiter
UPSTASH_REDIS_REST_TOKEN=             # required from #28 in production — distributed rate limiter
NEXT_PUBLIC_TURNSTILE_SITE_KEY=       # required from #28 (P1) — Cloudflare Turnstile CAPTCHA
TURNSTILE_SECRET_KEY=                 # required from #28 (P1) — server-only, never expose to client
NEXT_PUBLIC_SENTRY_DSN=               # required from #28 (P1) — error tracking
SENTRY_AUTH_TOKEN=                    # required from #28 (P1) — sourcemap upload at build
SENTRY_ORG=
SENTRY_PROJECT=
```

Generate the RS256 key pair once with:
```
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
```
Put PEM contents into `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` (replace literal newlines with `\n`). Pick any short `JWT_KEY_ID` (e.g. `2026-05-key1`) so a future rotation can serve both old + new public keys via JWKS without breaking vendors mid-flight. Never commit `private.pem`.

All required vars are validated at boot (Zod) — a missing/malformed required var fails fast (#1). `RESEND_API_KEY` is optional until #12 (warn-only). Accounts: Supabase (local CLI + hosted) before #1; Stripe (test mode + Stripe CLI for webhooks) before #5; Resend before #12; a domain before deploy.

## Progress (update as you go)
**Phase 0 (Foundation)**
- [x] #1 Project setup, auth, roles, test harness, env validation

**Phase 1 (MVP)**
- [x] #2 Database schema, RLS, anti-poaching boundary
- [x] #3 Public marketplace
- [x] #4 Vendor dashboard (incl. `min_price_cents` opt-in for resellers)
- [x] #5 Stripe Connect onboarding + product/price
- [x] #6 Subscribe + webhooks + entitlements
- [x] #7 Vendor hybrid pricing tiers + monthly cron (no flat fee)
- [x] #8 Anonymous token access
- [x] #9 Buyer dashboard
- [x] #10 Admin dashboard
- [x] #11 Testing & security hardening
- [x] #12 Observability & Stripe↔DB reconciliation

**Phase 2**
- [x] #13 Affiliate role + referral links + 50% split of platform cut
- [x] #14 Reseller role + $19/mo subscription + storefront offers + 5% platform fee

**Phase 3** (execute by wave — see `build_prompts/00-EXECUTION-ORDER.md`)

Wave 1 — quick wins (parallel-able):
- [x] #20 Weekly Friday payouts (Stripe Connect payout schedule)
- [x] #22 Reseller 30-day free trial

Wave 2 — backend pricing (sequential: #15 → #16 → #17):
- [x] #15 Vendor 4-tier pricing (12/8/5/3%)
- [x] #16 Reseller fee from markup (not gross)
- [x] #17 Net amount basis (after Stripe fees) — **blocks #18 and #24**

Wave 3 — design system:
- [x] #26 Tokens + 10 primitives + reference page (`/buyer`) — **blocks Wave 4–5 UI**

Wave 4 — affiliate redesign + refund policy (sequential: #18 → #19):
- [x] #18 Affiliate model redesign (vendor-funded, active-MRR-tiered) — **blocks #19 and #25**
- [x] #19 Refund vendor-only / dispute all-reverse split policy

Wave 5 — sticky features (parallel-able within wave):
- [x] #23 Subscription pause (`paused_until`, Stripe `pause_collection`)
- [x] #24 Vendor analytics (MRR, churn, cohort, LTV)
- [x] #25 Affiliate leaderboard + badges + public profiles

Wave 6 — docs:
- [x] #21 Final docs sync (SPEC.md §3/§4/§8/§11, CLAUDE.md, BUILD_PROMPTS.md)

**Phase 4 — Wave 7** (sequential: #27 → #28 → #29):
- [x] #27 Manual per-vendor commission override (admin-set bps, audit log, vendor trigger guard)
- [x] #28 Security hardening v2 (CSP, audit log helper, rate limiting)
- [ ] #29 White-label Tier 2 (vendor toggle, reseller subdomain storefront, per-offer WL branding)

## Guardrails
- Never expose buyer email, name, or card data to vendors, resellers, or affiliates — the anonymous token model (SPEC §6) and the `vendor_subscription_stats` / `reseller_sale_stats` / `affiliate_stats` boundaries (SPEC §7) are non-negotiable. None of these roles gets a read path to `subscriptions.buyer_id`.
- A user can never change their own `role` (privilege-escalation guard, RLS — SPEC §8).
- All money moves through Stripe Connect via **Separate Charges & Transfers** (SPEC §11); the platform never holds funds manually. **Voluntary refunds** (`charge.refunded`) reverse the vendor transfer only — platform and affiliate/reseller keep their cuts. **Disputes** (`charge.dispute.closed` outcome=lost) reverse ALL transfers for that invoice (vendor + affiliate or vendor + reseller).
- A `subscriptions` row may have AT MOST ONE of `affiliate_id` / `reseller_id` set (CHECK constraint). Reseller-sold takes priority — if both a `?aff=` cookie and a reseller-offer checkout collide, clear the affiliate cookie and record only the reseller attribution.
- Reseller-sold revenue does NOT count toward `vendor_billing.gross_revenue_cents` (vendor's tier is computed only from direct + affiliate sales; the vendor receives their fixed `min_price` floor on reseller sales, not a percentage).
- The reseller's $19/mo Stripe subscription is on the **platform account** (not Connect). Lapse → existing reseller commissions continue, but **new** offers and **new** sales are blocked (`reseller_offers.status` is forced to `paused`).
- Vendor cut precedence: `profiles.vendor_cut_bps_override` (admin-set, audited, 0–5000 bps) → `vendor_billing.cut_bps` (auto-tier) → 1200 default. Vendors cannot self-set the override — the `guard_vendor_cut_override` DB trigger blocks it.
- Entitlement is the DB reconciled from Stripe webhooks — never grant access off a client redirect.
- Use Stripe test mode (+ Stripe CLI for webhooks) until the full flow is verified end to end.
- Webhook handlers and any path that writes to ≥2 tables (subscribe, refund, cron) MUST run inside a single DB transaction (Supabase RPC or explicit `BEGIN/COMMIT`) — half-written state is the #1 source of subtle billing bugs.
- `anon_user_id` is **stable per `(buyer_id, app_id)` across resubscriptions** (SPEC §6) — on a new subscription, always look up a prior id for that pair before generating a new one.
- All admin state mutations write to `audit_log` in the same transaction as the mutation. Use the `writeAuditLog` helper in `lib/services/admin.ts`. `audit_log` is immutable (no UPDATE/DELETE policy) and admin-read-only via RLS.
- Webhook endpoints are exempt from rate limiting — Stripe retry logic depends on it. Idempotency is the dedupe mechanism.
- `checkRateLimit()` is async (Upstash Redis in production, in-memory fallback in dev). Always `await` it. Never add it to the webhook route.
- CSP rolls out report-only first (header: `Content-Security-Policy-Report-Only`). After 1 week of clean reports, switch to `Content-Security-Policy`. Never add `unsafe-eval`; tighten `unsafe-inline` with nonces in a future pass.
