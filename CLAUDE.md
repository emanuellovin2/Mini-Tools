# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# [PLATFORM]

A multi-sided marketplace where developers list SaaS apps and sell them on subscription; affiliates bring users via referral links; resellers run their own storefronts with markup over a vendor-set floor. The platform owns billing, access, and distribution.

**Economics at a glance:**
- **Vendor (direct sale):** platform takes 12%/8%/5%/3% by trailing monthly net tier ($0–$1k / $1k–$3k / $3k–$10k / $10k+). Computed on net amount (after Stripe fees). **No flat fee.**
- **Affiliate (referral):** vendor sets `affiliate_commission_bps` per app (20–80%). On affiliate sales: platform takes **5% of net**, affiliate gets their set %, vendor keeps the rest. Affiliate tier: 20%/25%/30% at $0/$5k/$20k active MRR generated. Commission snapshotted at subscribe time — tier changes only affect new subs.
- **Reseller (storefront):** pays **$19/month** for platform access (30-day free trial). On each sale: vendor gets `min_price` floor, platform takes **5% of markup** (Tier 1) or **2.5% of markup** (Tier 2 WL), reseller keeps the rest. Vendor with `open_to_wl` gets 33% kickback on platform commission (both tiers).

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
    reseller.ts      # createOffer, getOffers, getStorefrontOffer, upsertResellerSubscription, pauseOffersOnLapse, getResellerDashboard, upgradeOfferToWLTier2, cancelWLTier2, setResellerGlobalBranding, clearResellerGlobalBranding, getWLStorefrontOffer, getWLStorefrontOffers, setResellerOpenness
    reconciliation.ts  # runReconciliation(), getReconciliationRuns() — Stripe↔DB drift detection
    supabase.ts      # Supabase admin client (service role)
    supabase-server.ts  # Supabase server client (cookie-based session)
    supabase-browser.ts # Supabase browser client
  stripe/
    __tests__/       # Stripe helper tests (incl. affiliate.test.ts, reseller.test.ts — money math)
    anon-user.ts     # anonymous user token helpers
    billing.ts       # computeTier() pure function — 4 tiers: 1200/800/500/300 bps at $0/$1k/$3k/$10k net
    client.ts        # Stripe SDK singleton
    connect.ts       # Connect onboarding helpers (vendor + affiliate + reseller); syncResellerConnectBranding
    customers.ts     # Stripe Customer helpers
    entitlements.ts  # stripeStatusToSubscriptionStatus()
    products.ts      # product/price helpers
    transfers.ts     # transferVendorShare(), transferAffiliateShare(), computeResellerSplit(), transferResellerVendorFloor(), transferResellerShare(), reverseTransfers(), getVendorCutBps()
    webhook-handlers.ts  # all Stripe event handlers (+ structured logging, receipt/dunning emails)
  email/
    resend.ts        # sendSubscriptionReceipt, sendPaymentFailedNotice, sendChurnAlert, sendReconciliationDigest — all degrade gracefully on Resend outage
  auth/
    permissions.ts   # can(memberRole, action) — pure fn; one source of truth for org-role checks
    jwt.ts           # mintAccessToken, verifyAccessToken (RS256 via jose)
    roles.ts         # UserRole type, ROLE_DASHBOARDS map
    sdk.ts           # @platform/auth vendor-side token verification helper (JWKS-backed)
  services/
    org.ts           # createPersonalOrg, createTeamOrg, inviteMember, acceptInvite, listMembers, getActiveOrg
  jobs/
    queue.ts         # enqueueJob, claimJobs, completeJob, failJob, replayJob — durable async queue
    handlers.ts      # handler registry: handlers[type] = (payload, ctx) => result; built-in: erasure, export, webhook_delivery
  quotas/
    enforce.ts       # enforceQuota(orgId, resource) — throws QuotaExceededError (QUOTA_EXCEEDED); getQuotaUsage()
  db/
    with-timeout.ts  # withStatementTimeout(ms, fn) — SET LOCAL via claim_jobs RPC; presets: withFastTimeout/withStandardTimeout/withCronTimeout
  stripe/
    with-retry.ts    # withStripeRetry(fn) — 429/5xx exponential backoff + jitter, max 5 attempts; idempotent calls only
  cache/
    revalidate.ts    # revalidateMarketplace/App/Storefront/WLStorefront/AffiliateProfile/Leaderboard — tagged ISR invalidation
  validation/
    env.ts           # boot-time Zod env validation
    vendor.ts        # vendor input schemas
    reseller.ts      # reseller slug + offer schemas
    wl-brand.ts      # homoglyph deny-list + validateWLBrand() + WL_COLOR_REGEX (used for both global and per-offer WL brand validation)
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
    actions.ts         # createOfferAction, updateOfferStatusAction, upgradeOfferToWLTier2Action, cancelWLTier2Action
  r/
    [reseller-slug]/
      [offer-slug]/
        page.tsx       # public storefront: app info + offer price + Subscribe button; Tier 1 global mini-branding band
  _wl/
    [reseller-slug]/
      page.tsx         # WL subdomain landing: list active Tier 2 offers (subdomain rewrite target from proxy.ts)
      [offer-slug]/
        page.tsx       # WL storefront offer page: brand header + no platform attribution (except "Hosted by" legal)
  reseller/
    brand/
      page.tsx         # global mini-branding settings (Tier 1, free: logo + color + display name)
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
proxy.ts             # Next.js middleware: auth enforcement, role routing, ?aff= cookie capture (30d HTTP-only), affiliate click capture → analytics_events, subdomain rewrite (<slug>.<base> → /_wl/<slug>/)
supabase/
  migrations/        # all schema changes — never manual dashboard edits
  functions/
    monthly-billing-cron/     # Edge Function: 0 1 1 * * — writes vendor_billing rows (excludes reseller-sold via is_reseller_sale flag)
    daily-reconciliation-cron/ # Edge Function: 0 2 * * * — Stripe↔DB checks + Resend digest
    analytics-rollup-cron/    # Edge Function: 0 3 * * * — rolls up yesterday's analytics_events → analytics_daily (idempotent)
lib/
  analytics/
    hash.ts          # visitorHash (salted daily-rotating HMAC, no raw IP), isBot, isDnt — called by proxy + /api/events
    funnel.ts        # pure fns: buildFunnel, computeEpc, aggregateSources — tested, no DB
    __tests__/       # funnel.test.ts, hash.test.ts (25 tests)
types/
  supabase.ts        # auto-generated from `npm run types` — never hand-edit
scripts/
  set-weekly-payouts.ts   # one-shot: configure weekly Friday payout schedule on all connected accounts
```

## Reseller data model (as of #29)
- `profiles.reseller_openness` (`closed | open_to_resellers | open_to_wl`; default `open_to_resellers`) — vendor-set toggle. Only affects reseller sales. Direct sales always use 4-tier system.
- `profiles.wl_global_logo_url / wl_global_brand_color / wl_global_display_name` — Tier 1 global mini-branding (free, all-or-nothing CHECK; shown on `/r/<slug>/<offer>` storefront band).
- `reseller_offers.wl_tier` (1|2), `wl_status` (trialing|active|past_due|canceled), `wl_stripe_subscription_id` (UNIQUE per offer), `wl_logo_url / wl_brand_color / wl_display_name` (Tier 2 per-offer branding), `wl_trial_end`, `wl_last_sale_at`.
- `subscriptions.reseller_wl_tier_snapshot / vendor_openness_snapshot` — immutable after subscribe. Existing subs grandfathered at `(1, open_to_resellers)`.
- `VENDOR_WL_KICKBACK_BPS = 3333` in `lib/stripe/transfers.ts` — 33.33% of platform reseller commission goes to vendor if `open_to_wl`. Tunable const, never inline.

## Screenshots data model (as of #30)
- `apps.screenshot_urls text[]` — ordered list of public URLs. First element is marketplace preview/hero. CHECK: `cardinality = 0` (pending) or `3–7` (active). Approved apps require ≥3.
- Storage bucket `app-screenshots`: public read, vendor-prefixed write (`{vendor_id}/{nanoid}.{ext}`). Same PNG/JPG/WebP magic-bytes + 1MB cap as logos.
- Upload route: `POST /api/vendor/apps/screenshots` — authenticated vendor only, returns `{ url }`.
- `ScreenshotUploader` (`app/vendor/_components/`) — client component with 7-slot grid, HTML5 DnD reorder, per-slot upload progress, hidden inputs for FormData.
- `Lightbox` (`components/ui/Lightbox.tsx`) — keyboard nav (←→ ESC Home End), thumb strip, focus trap, body-scroll lock.
- `ScreenshotGallery` (`app/app/[id]/_components/`) — hero + 4-thumb grid + "+N more" pill, wraps Lightbox.

## Design system v2 (as of #31)
- **Tokens** (`app/globals.css`): `--font-size-base: 13px`, `--primary: 245 100% 68%` (#635bff), `--sidebar-w: 232px`, `--topbar-h: 56px`. Dark mode via `html[data-theme="dark"]`. HSL channel vars (`--primary: H S% L%`) are consumed by `bg-primary`/`text-primary` Tailwind utilities.
- **New primitives** (`components/ui/`): `Drawer` (slide-from-right, 520px, focus trap), `Sparkline` (SVG, `points` prop), `KpiCard` (label/value/delta/`sparkline`), `DenseTable`/`DenseRow`/`DenseCell` (CSS grid, `cols` prop, keyboard-accessible), `EmptyState` (icon/title/body/`cta`), `Tooltip` (120ms delay, `side` prop), `OnboardingChecklist` (circular SVG ring, collapsible), `NotificationBell` (unread badge, popover), `CommandPalette` (cmdk, ⌘K).
- **Updated primitives**: `Button` (new `outline` variant, `xs` size, `focus-visible:ring-primary/30`), `Badge` (ok/warn/bad/outline variants), `Skeleton` (rect/line/avatar variants, `lines` prop), `Toast` (new API: `add(msg, { type?, undo? })`, types: ok/warn/bad, 5s undo window).
- **Layout** (`components/layout/`): `Sidebar` (search slot, role footer, 232px), `Topbar` (env chip, breadcrumbs, notification bell slot), `DashboardShell` (mobile hamburger → sidebar drawer at <768px), `PageHeader` (tab bar support).
- **Per-role layouts** (`app/vendor/layout.tsx`, `app/affiliate/layout.tsx`, `app/admin/layout.tsx`, `app/reseller/layout.tsx`) — Server Components that wrap each dashboard in DashboardShell.
- **Dev page** (`app/dev/components/page.tsx`) — gated to `NODE_ENV=development`; shows all primitives.
- **Tests** (`components/ui/__tests__/primitives.test.tsx`) — 36 RTL tests covering all new primitives.

## Affiliate data model (as of #25)
- `profiles.affiliate_active_mrr_cents` — current active MRR (drives commission tier + leaderboard rank). Set by `increment_affiliate_mrr` RPC on `invoice.paid`; decremented on refund.
- `profiles.affiliate_lifetime_mrr_cents` — monotonic cumulative MRR (drives lifetime badges). Decremented on refund to keep badges honest.
- `profiles.slug` — shared between affiliates and resellers; UNIQUE globally. NULL = opted out of public profile (affiliate hides from `/affiliates/top` and their `/affiliates/<slug>` returns 404).
- `affiliate_badges` — static lookup table; badges are **derived** via `affiliate_earned_badges(p_affiliate_id)` RPC, not stored per-affiliate.
- `affiliate_leaderboard` — public view; excludes profiles where `slug IS NULL` or `affiliate_lifetime_mrr_cents = 0`.
- Public MRR display must be **rounded** (to nearest $100 or banded) — exact figures let competitors back-calculate subscriber counts.

## Organizations & async foundations data model (as of #47)
- `organizations` — `id`, `name`, `slug` (UNIQUE, nullable for personal), `type` (`personal|team`). Stripe Connect / payout columns (`stripe_account_id`, `charges_enabled`, `payouts_enabled`) **move here from `profiles`** — payouts are org-level.
- `org_members` — `(org_id, user_id)` UNIQUE; `role` (`owner|admin|member`). Required index: `(user_id, org_id) INCLUDE (role)`. `owner` = billing + delete; `admin` = manage products/members; `member` = operate, no billing.
- `org_invitations` — email + hashed token + role + `expires_at` + `accepted_at`. Token is single-use; expired/used tokens rejected.
- `jobs` — durable async queue (`type`, `payload`, `status` queued/running/succeeded/failed/dead, `attempts`, `locked_by`, `locked_until`, `idempotency_key`). Worker atomically claims via `FOR UPDATE SKIP LOCKED`. Paths that migrate here: erasure, export, analytics rollup, usage settlement, outbound webhook delivery.
- `org_quotas` — per-org caps: `max_offers`, `max_api_keys`, `max_workflows`, `api_rps`, etc. Default-deny for new resource types — every creatable resource MUST have a quota + enforcement.
- `audit_log.actor_org_id` — `writeAuditLog` MUST stamp this on every mutation going forward. Org admins read their org's rows at `/settings/organization/activity`; cross-org reads blocked by RLS.
- **Ownership shift:** `apps`, `reseller_offers`, `affiliate_links`, `reseller_subscriptions`, `vendor_billing`, `vendor_revenue_events` gain `org_id`. `profiles.role` stays as platform role (vendor/affiliate/reseller/buyer/admin); `org_members.role` governs within-org permissions. No `owner_type` discriminator — one ownership type: `org_id`.
- **Active-org context:** `getActiveOrg(session)` resolves the current org + caller's role; every service-layer call is scoped by it. Org switcher in the topbar (personal ↔ teams).

## Analytics event capture data model (as of #46)
- `analytics_events` — append-only, **partitioned monthly** (`PARTITION BY RANGE (created_at)`), **90d raw retention** (detached by `partition-rotation-cron`). Columns: `event_type` (`impression|view|click|signup|checkout_start|checkout_complete|launch|storefront_visit|marketplace_view`), `entity_type` (`app|offer|affiliate_link|storefront|agent|workflow|marketplace`), `entity_id`, `owner_org_id`, `affiliate_id`, `reseller_id`, `visitor_hash` (salted daily-rotating HMAC, **null when DNT/GPC**), `session_id`, `referrer`, `utm` (jsonb), `country`. **No UPDATE/DELETE** — service-role-only inserts.
- `analytics_daily` — rollup summary (kept indefinitely). Unique per `(date, event_type, entity_type, entity_id, owner_org_id, affiliate_id, reseller_id)`. `analytics-rollup-cron` (0 3 * * *) calls `rollup_analytics_day(date)` RPC (idempotent). Dashboards read rollups; raw events used only for granular queries ≤30d.
- **Privacy invariants:** `visitor_hash` = HMAC-SHA256(ANALYTICS_SALT_SECRET + date + ip + ua), truncated to 16 hex chars. Hash is daily-rotating — not linkable across days. DNT/Sec-GPC → `visitor_hash = null`. No buyer PII, no raw IP ever stored.
- **Capture surface:** `POST /api/events` (batched, max 20, rate-limited 60/min/IP, bot-filtered). Server-side: affiliate `?aff=` click in `proxy.ts` → `click` event; `lib/services/analytics.ts` → `recordEvent()` for checkout events.
- **Funnel functions:** `lib/services/analytics.ts` — `getAffiliateFunnel` (clicks→signups→checkout→subscribe + EPC + click→sale%), `getOfferFunnel` (storefront→checkout→subscribe + traffic sources), `getVendorFunnel` (impression→view→checkout→subscribe per app), `getAdminFunnel` (channel attribution). All read `analytics_daily`; pure math in `lib/analytics/funnel.ts`.
- `lib/services/affiliate.ts:getAffiliateFunnel` and `lib/services/reseller.ts:getOfferAnalytics` **delegate** to the analytics service — same public API, enriched with top-of-funnel data.
- `ANALYTICS_SALT_SECRET` — required env var. Add to `.env.local`. Missing → falls back to `dev-salt-not-for-production` (logged warning in production).

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
STRIPE_WL_TIER2_PRICE_ID=             # required from #29 — $29/mo recurring Stripe Price for Tier 2 per-offer WL upgrades
UPSTASH_REDIS_REST_URL=               # required from #28 in production — distributed rate limiter
UPSTASH_REDIS_REST_TOKEN=             # required from #28 in production — distributed rate limiter
NEXT_PUBLIC_TURNSTILE_SITE_KEY=       # required from #28 (P1) — Cloudflare Turnstile CAPTCHA
TURNSTILE_SECRET_KEY=                 # required from #28 (P1) — server-only, never expose to client
NEXT_PUBLIC_SENTRY_DSN=               # required from #28 (P1) — error tracking
SENTRY_AUTH_TOKEN=                    # required from #28 (P1) — sourcemap upload at build
SENTRY_ORG=
SENTRY_PROJECT=
KEY_VAULT_MASTER_KEYS=                 # required from #41 — JSON of versioned AES-256 master keys, e.g. {"1":"<base64-32B>"} — wraps per-record DEKs (envelope encryption for provider keys + connector OAuth tokens)
KEY_VAULT_ACTIVE_VERSION=             # required from #41 — which KEY_VAULT_MASTER_KEYS version wraps NEW secrets (rotation: add a new version, re-wrap, then bump this)
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
- [x] #29 White-label Tier 2 (vendor toggle, reseller subdomain storefront, per-offer WL branding)

**Phase 5 — Wave 8** (sequential: #30 + #31 first, then #32–#39 parallel-able)
- [x] #30 App screenshots gallery (3–7/app, lightbox, drag-reorder, marketplace preview)
- [x] #31 Design system v2 (Stripe-density tokens, drawer/sparkline/cmdk/skeleton/empty-state/toast/bell/onboarding primitives, mobile responsive, dark mode)
- [x] #32 Vendor dashboard v2 (channel mix, Stripe Connect balance, dunning queue, refund/dispute feed, per-app drill-down drawer, openness panel with kickback earnings, transparent fee breakdown)
- [x] #33 Affiliate dashboard v2 (conversion funnel, apps-to-promote catalog, earnings per app, Connect status, payout history, pending earnings, refund clawbacks, sticky referrals, share kit with QR)
- [x] #34 Reseller dashboard v2 (resellable apps catalog, per-offer analytics drawer, vendor change alerts, Tier 2 WL panel, markup simulator, kickback transparency)
- [ ] #35 Buyer dashboard v2 (upcoming charges calendar, payment methods, invoice history, per-sub drawer, cancel-with-reason, pause-until date picker, privacy panel)
- [x] #36 Admin dashboard v2 (system health, take-rate trend, channel mix, concentration risk, payout obligation, webhook health + DLQ, drill-downs, manual support tools, feature flags, JWT rotation, tax export)
- [ ] #37 Marketplace v2 (search, category nav, filters, sort, screenshot cards, featured carousel, SEO)
- [ ] #38 Fee transparency layer (live calculators in vendor/reseller/affiliate forms, optional buyer breakdown, canonical `/legal/fees` page)
- [ ] #39 Cross-role: notifications bell + preferences, account settings (2FA/sessions/data export/delete), onboarding checklist per role, CSV export everywhere, vendor webhook subscribers

**Phase 6 — Wave 9 (Usage economy — the "4 kitchens" + foundations)** — design constraint: **BYOK + prepaid credits = zero/minimal compute cost to platform**; usage-based earnings for vendor/reseller/affiliate. **Foundation-first ordering: #47 → #48 → #46 → kitchens → #45.** #47/#48/#46 capture decisions that cannot be reconstructed retroactively — never defer.
- [x] #47 Organizations & multi-seat (the ownership model) — `organizations`, `org_members`, personal-org bootstrap + backfill, RLS rewrite via `is_org_member` (STABLE SECURITY DEFINER + `org_members(user_id, org_id) INCLUDE (role)` index), payouts move to org, `audit_log.actor_org_id` + team activity feed — **BLOCKS #48** (pre-launch clean-break, retrofit cost explodes after launch)
- [x] #48 Scale & resilience foundation — durable `jobs` table + tick worker, `org_quotas` + enforce, `statement_timeout` middleware, outbound webhook delivery worker, partition/retention/RLS-perf conventions in ENGINEERING.md, edge caching policy (ISR + on-demand revalidation), k6 smoke harness, Stripe 429 retry wrapper, PITR restore runbook — **BLOCKS #46/#40+** (they consume these primitives from day 1)
- [x] #46 Engagement & analytics event capture — append-only `analytics_events` (monthly partition, salted daily-rotating visitor hash, no PII, DNT), beacon + server capture, rollup cron via jobs queue, REAL funnels (affiliate EPC + click→sale, reseller traffic→conversion, vendor impression→install) — **capture-now, depends on #47 + #48**
- [ ] #40 Usage metering ledger + usage-based billing (the meter) — generic `usage_events` ledger, prepaid `credit_wallets`, settlement cron, `computeUsageSplit` pure fn — **BLOCKS #41–#44**
- [ ] #41 AI Gateway (BYOK) (the door) — encrypted `provider_keys` vault, `/api/gateway/[provider]` metered proxy, vendor agent products, spend caps — first usage revenue, zero compute cost
- [ ] #42 Workflow / automation engine (the recipe book) — `workflows`/`workflow_versions`/`workflow_runs`/`run_steps`, triggers (manual/schedule/webhook), durable tick-driven executor, sellable templates
- [ ] #43 Connectors / integrations (the lock-in) — versioned connector registry (Gmail/Slack/Sheets/HTTP), encrypted OAuth `connector_accounts`, workflow step wiring
- [ ] #44 Usage-product distribution — metered products in marketplace, reseller per-unit markup, affiliate recurring % of platform fee, role usage-earnings dashboards
- [ ] #45 Partner-client data lifecycle & DPA + CRM seam — `partner_clients` identity registry (tags/lifecycle_stage/notes — agency client book), cross-kitchen erasure/export hooks, retention cron, `/legal/dpa` — legal foundation for §13 (platform = data processor); depends on #40/#41/#43/#47

**Wave 8 stragglers — org-aware (run after #47):**
- [ ] #37 Marketplace v2 + **reviews & ratings** (`app_reviews`, verified-purchase only, trigger-maintained `rating_avg/rating_count` on apps) — reputation = non-portable stickiness
- [ ] #39 Cross-role: notifications/2FA/sessions/onboarding/CSV/**vendor webhook subscribers** (v1.* event versioning) + **partner platform API** (`api_keys` test/live mode, `idempotency_keys`, scoped + rate-limited `/api/v1/*`) — embedding stickiness

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
- Vendor cut on **direct sales** always uses the 4-tier system (12/8/5/3%) plus any admin override. The `reseller_openness` toggle does NOT affect direct sales.
- Vendor never pays a per-sale tax on reseller sales. Income = `floor` (`open_to_resellers`) or `floor + 33% × platform_commission` (`open_to_wl`). `vendor_openness_snapshot` is immutable after subscribe — vendor flipping later does not retroactively change live subs.
- Tier 2 subscribe requires live check: `vendor.reseller_openness='open_to_wl'` at checkout time. `computeResellerSplit` enforces: (1) Tier 2 → openness must be `open_to_wl`; (2) sum invariant `vendor+platform+reseller===amount`; (3) `platformCut >= 0`. Throws on violation.
- `VENDOR_WL_KICKBACK_BPS = 3333` exported const in `lib/stripe/transfers.ts`. Never inline. CI fuzz test (1000 iters) must always satisfy sum invariant + non-negative platform cut.
- Brand uploads: PNG/JPG/WebP only (no SVG — XSS risk), 1MB max, magic-bytes verified. Display name passes homoglyph-normalized deny-list in `lib/validation/wl-brand.ts`.
- Subdomain enumeration: non-existent or inactive Tier 2 → 404. Buyer dashboard (`/buyer`) NEVER WL-branded — redirect to canonical domain from subdomain (anti-poaching).
- Reserved subdomains in `proxy.ts`: www/api/admin/auth/app/dashboard/support/help/mail/email/ftp/ns1/ns2/staging/dev/test/prod — hardcoded; add any new ops subdomain here before creating a reseller slug with that name.
- **RLS performance (load-bearing from #47+):** `is_org_member(org_id, min_role)` and any RLS helper that hits a lookup table MUST be `STABLE SECURITY DEFINER` so Postgres caches it per query (not per row). On hot tables prefer `org_id = ANY(SELECT my_org_ids())` over per-row scalar `is_org_member` calls. `my_org_ids()` is a `STABLE SETOF uuid` helper the planner inlines once. Never use `auth.uid()` in a subquery that runs per-row on large tables.
- **Migration safety on hot tables:** never `ALTER TABLE ADD COLUMN NOT NULL DEFAULT <expr>` (full rewrite + AccessExclusiveLock). Never `CREATE INDEX` without `CONCURRENTLY`. Never `ADD CONSTRAINT` without `NOT VALID` + `VALIDATE CONSTRAINT`. Pattern: (1) add nullable column — instant; (2) backfill in batches (`UPDATE ... WHERE id IN (... LIMIT 10000)` looped, or as a `jobs` row); (3) set `NOT NULL` once verified.
- **Every new creatable resource** (offer, api_key, workflow, connector, webhook endpoint) MUST add a quota row in `org_quotas` + call `enforceQuota()` in the creation path. Default-deny stance; never silently allow unbounded resource creation.
