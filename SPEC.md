# [PLATFORM] — Product & Engineering Spec

> Source of truth for every build session. Read this file first in any new chat before writing code.

## 1. Vision
[PLATFORM] is a marketplace where independent developers list their SaaS apps and sell them on subscription. Buyers — freelancers, founders, and small agencies — discover and subscribe to niche AI/SaaS tools in one place. The platform owns billing, access, and distribution; vendors only build, affiliates only refer, and resellers run their own storefronts on top of the platform.

## 2. Roles
- **Admin (the owner):** approves vendors/apps, views all transactions, monitors churn, manages payouts.
- **Vendor:** lists apps, sets price (and optional resell floor `min_price`), integrates the access SDK once, sees earnings. **Never sees buyer email, name, or payment data** — only an anonymous user id per subscriber.
- **Buyer:** subscribes to apps and launches them from one central dashboard.
- **Affiliate (Phase 2):** brings new users via referral links and earns a **vendor-set commission % of net** on each attributed transaction (platform takes a flat 5% of net; vendor sets the affiliate's %). Touches no checkout, no customer relationship, no markup.
- **Reseller (Phase 2):** pays **$19/month** for a sales dashboard + the ability to resell vendor apps through their own checkouts/links. Sets a markup over each vendor's `min_price`, keeps 95% of that markup as profit, and platform takes **5% of the markup** on every transaction processed via their checkout.

Roles are assigned **server-side only**. A user can never change their own `role` (privilege-escalation guard, enforced in RLS — see §8). Affiliate and reseller are distinct roles — a user can be one or the other (not both) in addition to buyer/vendor combinations as profile-level data allows.

## 3. Business model — vendor hybrid pricing (per vendor, by trailing calendar-month revenue)
Tiers are evaluated in **integer cents**; the percentage cut is stored in **basis points** (bps) to avoid floats. **There are no monthly flat fees** — the platform's only take from a direct (non-reseller) vendor sale is the percentage cut below.

| Tier | Monthly gross (cents) | Platform cut |
|------|----------------------|--------------|
| 1 | `gross < 100_000` ($0–$1,000) | 1200 bps (12%) |
| 2 | `100_000 ≤ gross < 300_000` ($1,000–$3,000) | 800 bps (8%) |
| 3 | `300_000 ≤ gross < 1_000_000` ($3,000–$10,000) | 500 bps (5%) |
| 4 | `gross ≥ 1_000_000` ($10,000+) | 300 bps (3%) |

Boundary rule: lower bound inclusive, upper bound exclusive. Exactly $1,000 → Tier 2; exactly $3,000 → Tier 3; exactly $10,000 → Tier 4.

- **Gross revenue** = sum of buyer payments **successfully captured** for the vendor's apps **via the platform's own checkout** in a calendar month (UTC), **net of refunds/chargebacks that occur in that same calendar month** (cash-basis), in cents. **Reseller-sold transactions are excluded** from this gross (the vendor receives a fixed `min_price` floor on those, not a percentage of a marked-up price — see §4b). Refunds and dispute losses are subtracted from the month they OCCUR, not the month of the original charge — this keeps tier computation forward-only and never re-tiers a closed `vendor_billing` period. Gross is floored at 0: a refund-heavy month where refunds exceed new charges counts as $0 gross for tier purposes (Tier 1). It excludes the platform cut.
- **Tier is frozen per period.** A monthly cron computes each vendor's tier from the **just-ended** calendar month and writes a `vendor_billing` row. That tier governs the **next** cycle's percentage cut. The cut applied to any charge is always read from the active `vendor_billing` row — never recomputed live at charge time.
- **New vendor with no history → Tier 1** for the first period.
- **Percentage cut** is realized per paid invoice via a Stripe **transfer** to the vendor (see §11).
- **Commission basis:** all commissions (vendor share, affiliate share, reseller share) are computed on the **net amount** — `balance_transaction.net` from Stripe, i.e. what remains after Stripe deducts its processing fee (≈2.9% + 30¢). The platform bears no additional fee absorption; the Stripe fee is simply deducted at source before splits. Tier thresholds (§3 table above) are applied to the **gross** `invoice.amount_paid` so the volume brackets reflect what buyers actually paid.

## 4. Affiliate & Reseller economics (Phase 2)

Affiliate and Reseller are two distinct revenue paths. Any given subscription is either **direct** (no third party), **affiliate-attributed**, or **reseller-sold** — never two at once. The subscription row stores at most one of `affiliate_id` / `reseller_id`; a partial-unique constraint enforces this.

### 4a. Affiliate model
- Recurring referral, **NOT** white-label. The product keeps its original branding and the buyer checks out on the platform's own checkout via a tagged link (`?aff=<code>`).
- **Vendor-funded commission:** each vendor sets `affiliate_commission_bps` per app (minimum 2000 bps / 20%, maximum 8000 bps / 80%). On every attributed paid invoice, platform takes a flat **5% of net** (`500 bps`), the affiliate receives their snapshotted commission bps of net, and the vendor receives the remainder. Example: vendor sets 30% commission, tier-1 price $50, Stripe net ≈$48.56 → platform $2.43 (5%), affiliate $14.57 (30%), vendor $31.56 (65%). Vendor's net share rises as they set a lower commission; the platform's 5% is fixed regardless of vendor tier.
- **Affiliate MRR tiers** cap the commission a new subscriber can earn at the moment of subscribe: at $0 active MRR the cap is 20%, at $5k active MRR the cap is 25%, at $20k active MRR the cap is 30%. The vendor's set `affiliate_commission_bps` is clamped to the affiliate's current tier cap and snapshotted into `subscriptions.affiliate_commission_snapshot_bps` — immutable thereafter. Tier changes only affect new subscriptions.
- **Self-referral is rejected** server-side (a buyer cannot be their own affiliate; an affiliate's own logged-in checkout ignores the cookie).
- Commission **recurs as long as the subscription is active** and **stops when it truly ends** (cancel-at-period-end alone does not stop it — actual `canceled` does).
- Affiliates receive funds via **Stripe Connect (Express)** and must complete onboarding before they can be paid. Payouts use **Separate Charges & Transfers** (§11) — one transfer per recipient per paid invoice. Payouts run weekly on Fridays.

### 4b. Reseller model
- A reseller pays **$19/month** to the platform for access (Stripe subscription on the platform account — **not** Connect). While the subscription is `active|trialing`, the reseller can publish offers and run checkouts; if it lapses (`past_due|canceled|unpaid|paused`), **new offers and new sales are blocked**, but existing customer subscriptions and the reseller's commission on them continue normally until they end (the buyer paid for a service and the reseller already earned that recurring share).
- The reseller picks vendor apps where `apps.min_price_cents IS NOT NULL` (the vendor opted in to resell distribution) and creates a **`reseller_offer`** with a `sell_price_cents` ≥ `min_price_cents`. The offer is published at a slug under the reseller's namespace (e.g. `/r/<reseller-slug>/<offer-slug>`).
- Buyer checks out on the platform's own checkout (still merchant of record), paying `sell_price_cents`. The split on each paid invoice for a reseller-sold subscription is:
  - **Vendor:** `vendor_floor_cents` (snapshot of the offer's vendor floor at subscribe time). Vendor's tier % does **not** apply — they accepted the floor.
  - **Platform:** `5% × (sell_price_cents − vendor_floor_snapshot_cents)` (500 bps of the markup only).
  - **Reseller:** `(sell_price_cents − vendor_floor_snapshot_cents) × 95%` (95% of the markup).
  - **Worked example:** buyer pays $50, vendor floor $40, markup $10 → platform $0.50 (5% × $10), reseller $9.50 (95% × $10), vendor $40.
- The reseller's $19/mo subscription is independent and continues to bill regardless of sales volume; lapses block **new** business per the rule above.
- Resellers receive funds via **Stripe Connect (Express)** and must complete onboarding before they can be paid out on offers.
- **Self-resell is rejected**: a reseller cannot subscribe a buyer (themselves or any other logged-in user) to their own offer where the buyer's user id matches the reseller's, and a vendor cannot use a reseller offer for their own app.
- A vendor may set `min_price_cents = NULL` on an app to **opt out of resell** — the app can only be sold via direct platform checkout.
- Commission **recurs as long as the subscription is active** and **stops when it truly ends** (same rule as affiliate).

## 5. Tech stack
- **Next.js** (App Router, TypeScript) — frontend + API routes.
- **Supabase** — Postgres, Auth, Storage.
- **Vercel** — hosting.
- **Stripe Connect (Express accounts)** — payments + multi-party splits. The **platform is the merchant of record**; buyers are charged on the platform account, vendor/reseller shares move via transfers.
- **Resend** — transactional email (receipts, dunning, admin alerts).
- **JWT (RS256)** — signed, short-lived access tokens for app launches, with a `kid` header and a public **JWKS** endpoint for rotation.
- App language: **English**. **Currency: USD only** for MVP.

## 6. Access model — anonymous token (anti-poaching core)
Buyers ALWAYS launch apps from the [PLATFORM] dashboard. On each launch:
1. Platform mints a short-lived signed JWT (RS256) with claims: `iss` (platform), `aud` (the specific `app_id` being launched), `sub` (the **opaque** anonymous user id, e.g. `usr_` + 16 random bytes base62 — **never sequential/guessable**), `active` (subscription status snapshot), `jti` (nonce), `iat`, and `exp` ≤ 5 minutes.
2. Buyer is redirected to the vendor app: `vendor-app.com/auth?token=...`.
3. Vendor app verifies the token (via the `@platform/auth` SDK or the `/api/verify` endpoint), checks `aud` matches its own app id, then starts a session keyed on the anonymous user id.

Hardening requirements:
- `/api/verify` validates **signature, `exp`, `iss`, `aud`**, and then re-reads the **live** subscription status from the DB (the token's `active` is only a 5-minute snapshot). It returns `{ user_id, active }` with **no PII**. It is rate-limited and allows a small `clockTolerance` (e.g. 30s) for clock skew.
- Anonymous user id is **stable per `(buyer_id, app_id)` across resubscriptions** — if a buyer cancels and later resubscribes to the same app, the vendor MUST see the same `anon_user_id` (preserves vendor's in-app history for the same buyer). Implementation: on every new subscription, look up any prior `anon_user_id` for that `(buyer_id, app_id)` pair from the `subscriptions` table (regardless of status) and reuse it; only generate a new one if no prior row exists. There is **no DB `UNIQUE` constraint** on `subscriptions.anon_user_id` — the same id is intentionally repeated across rows for the same buyer×app. Collision risk with 16 random bytes is negligible (~2⁻¹²⁸), so no DB-level uniqueness is needed across distinct pairs.
- Vendors never receive buyer email, name, or card data. Billing always runs through the platform's Stripe. This — plus the platform being the constant source of new customers — is the defensibility, replacing the need for a heavy legal contract.

## 7. Database schema (core tables)
All money columns are `bigint` cents with `CHECK (>= 0)`. All status/role columns are Postgres enums (or `CHECK` constraints). Every table has `created_at`; mutable tables have `updated_at` (via trigger). Index every foreign key and every column used in RLS or filtering.

- **`profiles`** — `id` (uuid, = `auth.users.id`), `role` (admin|vendor|buyer|affiliate|reseller), `display_name` (text, nullable; vendor's public marketplace name, reseller's storefront name, affiliate's payout name — buyers may leave it null), `slug` (text, nullable, UNIQUE globally — shared namespace for reseller storefronts (`/r/<slug>/...`) and affiliate public profiles (`/affiliates/<slug>`); lower-kebab; `NULL` = opted out of public profile), `stripe_account_id` (vendor/reseller/affiliate Connect acct, nullable), `stripe_customer_id` (buyer or reseller paying the $19/mo, nullable; a user who is *both* a vendor and a buyer may have both set), `charges_enabled` (bool, default false), `payouts_enabled` (bool, default false), `affiliate_active_mrr_cents` (bigint, default 0 — sum of `price_cents` for the affiliate's active/trialing subscriptions; updated by `increment_affiliate_mrr` RPC on `invoice.paid` and decremented on cancellation/refund; drives commission tier cap for new subs), `affiliate_lifetime_mrr_cents` (bigint, default 0 — monotonically increasing cumulative MRR; decremented on refund to keep badges honest; drives lifetime badge thresholds), `created_at`, `updated_at`. *Buyer email lives in `auth.users` / Stripe — never duplicated where a vendor could read it. `display_name` is the only profile field exposable to vendors/marketplace. Affiliates with `slug IS NULL` are excluded from the public leaderboard and their `/affiliates/<slug>` returns 404.*
- **`apps`** — `id`, `vendor_id` → profiles, `name`, `description`, `category`, `price_cents` (bigint — direct checkout price), `min_price_cents` (bigint, nullable — vendor's floor for reseller offers; `NULL` = app is **not** resellable; when set must satisfy `min_price_cents <= price_cents`), `affiliate_commission_bps` (int, nullable, range 2000–8000 — vendor-set affiliate commission; `NULL` = no affiliate program for this app; clamped to affiliate's MRR tier cap at subscribe time), `currency` (default 'usd'), `auth_url`, `logo_url`, `status` (pending|approved|rejected, default pending), `stripe_product_id` (nullable), `stripe_price_id` (nullable — for direct checkout), `created_at`, `updated_at`. Indexes: `(status)`, `(vendor_id)`, `(category)`, `(min_price_cents) WHERE min_price_cents IS NOT NULL` *(drives reseller catalog queries)*.
- **`reseller_offers`** *(Phase 2)* — `id`, `reseller_id` → profiles, `app_id` → apps, `slug` (text — offer-level slug under the reseller's namespace), `sell_price_cents` (bigint — **must satisfy `sell_price_cents >= apps.min_price_cents` at insert/update** via trigger; vendor floor is captured by snapshot per subscription, not here), `vendor_floor_snapshot_cents` (bigint — copy of `apps.min_price_cents` at offer-create time, used for accounting transparency), `stripe_price_id` (nullable — per-offer Stripe Price; one Price per offer because price differs from app's direct Price), `status` (draft|active|paused, default draft), `last_observed_floor_cents` (bigint, nullable — last floor the reseller dashboard observed; compared against current `apps.min_price_cents` to surface "floor changed" alert banners), `last_observed_openness` (text, nullable — last `profiles.reseller_openness` for this offer's vendor; compared against current to surface "openness downgraded" alerts), `created_at`, `updated_at`. Constraints: `UNIQUE(reseller_id, slug)`, `UNIQUE(reseller_id, app_id)` (one offer per app per reseller), `CHECK (sell_price_cents >= vendor_floor_snapshot_cents)`. Indexes: `(reseller_id)`, `(app_id)`, `(status)`.
- **`reseller_subscriptions`** *(Phase 2)* — `id`, `reseller_id` → profiles UNIQUE, `stripe_subscription_id` (text UNIQUE — the $19/mo platform Sub), `status` (same enum as `subscriptions.status`), `current_period_end` (timestamptz), `cancel_at_period_end` (bool, default false), `canceled_at` (timestamptz, nullable), `created_at`, `updated_at`. Drives the "may publish new offers / take new sales" gate (§8).
- **`subscriptions`** — `id`, `buyer_id` → profiles, `app_id` → apps, `stripe_subscription_id` (text, UNIQUE — implicit index), `stripe_customer_id`, `status` (incomplete|incomplete_expired|active|trialing|past_due|canceled|unpaid|paused), `price_cents` (**snapshot at subscribe time** — what the buyer actually pays; equals `apps.price_cents` for direct/affiliate sales and `reseller_offers.sell_price_cents` for reseller-sold sales), `currency`, `anon_user_id` (text, opaque — **not unique** on this table; stable per `(buyer_id, app_id)` across resubscriptions, see §6), `cancel_at_period_end` (bool, default false), `current_period_end` (timestamptz), `canceled_at` (timestamptz, nullable), `paused_until` (timestamptz, nullable — set when buyer pauses via `pause_collection`; cleared on resume or when the pause period ends naturally; access is false while non-null), `affiliate_id` (uuid → profiles, nullable — set at subscribe time from a valid `?aff=` cookie; **immutable thereafter**), `affiliate_commission_snapshot_bps` (int, nullable — snapshotted value of the affiliate's clamped commission bps at subscribe time; immutable; non-null iff `affiliate_id` is non-null), `reseller_id` (uuid → profiles, nullable — set when the subscription was created from a `reseller_offer`; **immutable thereafter**), `reseller_offer_id` (uuid → reseller_offers, nullable — must be non-null iff `reseller_id` is non-null), `vendor_floor_snapshot_cents` (bigint, nullable — snapshot of `reseller_offers.vendor_floor_snapshot_cents` at subscribe, used to compute the vendor's fixed share per invoice; non-null iff `reseller_id` is non-null), `created_at`, `updated_at`. Constraints: **partial unique** `(buyer_id, app_id)` where `status IN ('incomplete','active','trialing','past_due')` (no double active subscription); **`CHECK NOT (affiliate_id IS NOT NULL AND reseller_id IS NOT NULL)`** (mutually exclusive attribution); **`CHECK ((reseller_id IS NULL) = (reseller_offer_id IS NULL))`**; **`CHECK ((reseller_id IS NULL) = (vendor_floor_snapshot_cents IS NULL))`**; **`CHECK ((affiliate_id IS NULL) = (affiliate_commission_snapshot_bps IS NULL))`**. Indexes: `(buyer_id)`, `(app_id)`, `(status)`, `(anon_user_id)`, `(buyer_id, app_id)`, `(affiliate_id) WHERE affiliate_id IS NOT NULL`, `(reseller_id) WHERE reseller_id IS NOT NULL`.
- **`vendor_billing`** — `id`, `vendor_id` → profiles, `period_start` (date), `period_end` (date), `gross_revenue_cents` (bigint — direct + affiliate-attributed gross only; reseller-sold gross is excluded per §3), `tier` (1|2|3|4), `cut_bps` (int), `computed_at`. Constraint: `UNIQUE(vendor_id, period_start)` (idempotent cron).
- **`webhook_events`** — `id` (text PK = **Stripe event id**), `type`, `payload` (jsonb), `status` (received|processed|failed), `received_at`, `processed_at` (nullable), `error` (nullable). Process each event id **exactly once**.
- **`audit_log`** — `id`, `actor_id` (nullable; null = system), `actor_role`, `action`, `entity_type`, `entity_id`, `metadata` (jsonb), `created_at`. Append-only: insert by service role, read by admin, never updated/deleted.
- **`affiliate_links`** *(Phase 2)* — `id`, `affiliate_id` → profiles, `code` (text UNIQUE — the `?aff=` value), `app_id` (nullable; null = generic link that attributes any app), `created_at`.
- **`affiliate_attributions`** *(Phase 2)* — `id`, `subscription_id` UNIQUE → subscriptions, `affiliate_id` → profiles, `code` (text), `attributed_at` (timestamptz). Written once at subscribe time; never updated.
- **`affiliate_badges`** *(Phase 3)* — `id`, `slug` (text UNIQUE — stable identifier), `name`, `description`, `threshold_cents` (bigint — active or lifetime MRR threshold in cents that unlocks the badge). Static lookup table; badges are **derived** — the `affiliate_earned_badges(p_affiliate_id)` RPC joins this table against `profiles.affiliate_active_mrr_cents` / `affiliate_lifetime_mrr_cents`. No per-affiliate row is stored.
- **`vendor_revenue_events`** *(Phase 3, from #17)* — `id`, `vendor_id` → profiles, `subscription_id` → subscriptions, `invoice_id` (text — Stripe invoice id), `gross_amount_cents` (bigint — `invoice.amount_paid`), `net_amount_cents` (bigint — `balance_transaction.net`; the basis for all transfer math), `stripe_fee_cents` (bigint — gross − net), `type` (text — 'charge'|'refund'), `created_at`. Used by vendor analytics (MRR, churn, cohort, LTV) and the monthly billing cron.

**Views (read-only, no direct table grants to non-service roles):**
- **`affiliate_leaderboard`** — public view; top affiliates by `affiliate_active_mrr_cents` DESC then `affiliate_lifetime_mrr_cents` DESC; excludes profiles where `slug IS NULL` or `affiliate_lifetime_mrr_cents = 0`; rounds MRR to nearest $100 to prevent subscriber-count back-calculation.

**Anti-poaching data boundary:** vendors get **no direct read** on `subscriptions`. They read a view/RPC (`vendor_subscription_stats`) exposing only `app_id`, `anon_user_id`, `status`, `price_cents`, `current_period_end` for **their own apps** — never `buyer_id`, never anything joinable to a buyer's identity. **Resellers** likewise get **no direct read** on `subscriptions.buyer_id` for their reseller-sold rows — they see only an anonymous identifier, a sale price, and status via a `reseller_sale_stats` view/RPC. Affiliates see only aggregate stats (count of active attributed subs, MRR earned) via an `affiliate_stats` view — never per-buyer detail.

## 8. Critical business rules
- **Role escalation guard:** the `profiles` UPDATE RLS policy must enforce `WITH CHECK (role = OLD role)` — a user may edit their profile but never change their own role. Role/Connect/customer columns are written only via service role.
- **App listing gate:** an app may only be `approved`/visible in the marketplace if its vendor has `charges_enabled = true`. Never let a buyer subscribe to an app whose vendor cannot receive funds.
- **Entitlement = DB, reconciled from Stripe.** Never grant access off an unconfirmed client redirect. The `subscriptions.status` is driven by webhooks (§11), and access is derived from it via the state machine below.
- **Status → access state machine** (the only source of the token's `active` — implemented as a SINGLE shared pure function used by both the webhook handler and `/api/verify`):

  | Stripe status | `subscriptions.status` | Access (`active`) |
  |---|---|---|
  | incomplete | incomplete | false |
  | incomplete_expired | incomplete_expired | false |
  | active | active | true |
  | trialing | trialing | true |
  | past_due | past_due | **false** (suspended; retained for dunning) |
  | unpaid | unpaid | false |
  | paused | paused | false |
  | canceled | canceled | false |

  With `cancel_at_period_end = true`, status stays `active` (access true) until `current_period_end`, then flips to `canceled`. Any Stripe status not listed here is a bug — the shared function MUST throw rather than silently default to `active=false`, so the audit_log captures the unknown state.
- **Cancellation = at period end** (`cancel_at_period_end`). Access continues until `current_period_end`; no proration/refund. Affiliate / reseller commission stops when the subscription truly ends (status flips to `canceled`/`unpaid`/`incomplete_expired`).
- **Refunds & disputes reverse money (distinct policies):** on `charge.refunded` (voluntary refund), reverse **only the vendor's transfer** — the platform and any affiliate or reseller keep their cuts (they already provided their service: referral or storefront). On `charge.dispute.closed` with outcome=`lost`, reverse **ALL transfers** for that invoice (vendor + affiliate, or vendor + reseller) — a chargeback means the full payment is clawed back. Handle resulting negative balances on connected accounts.
- **Idempotency everywhere:** Stripe writes carry idempotency keys; webhook events are processed once (`webhook_events`); the monthly cron is safe to re-run (`UNIQUE(vendor_id, period_start)`).
- **Default tier for new vendors:** until the first monthly cron writes a `vendor_billing` row for a vendor, transfers on `invoice.paid` use **Tier 1 defaults** (`cut_bps = 1200`). The shared helper that reads `cut_bps` for a transfer MUST return Tier 1 defaults when no `vendor_billing` row exists for the vendor at charge time — never crash, never default to 0% cut.
- **Reseller subscription gate:** publishing/updating a `reseller_offer` to `status='active'` and creating any new subscription via a reseller's offer both require `reseller_subscriptions.status IN ('active','trialing')` for that reseller. Existing customer subscriptions and the reseller's commission on them continue normally if the $19/mo lapses; only **new** business is gated.
- **Self-attribution rejection:** at subscribe time, drop a `?aff=` cookie whose `affiliate_id = buyer_id` (server-side); reject any reseller-offer checkout where `reseller_id = buyer_id`; reject any reseller-offer creation where the offer's `app.vendor_id = reseller_id`.
- **Connect deauthorization:** on `account.application.deauthorized`, set `profiles.charges_enabled = false` and `payouts_enabled = false` for that vendor; the marketplace listing query already filters on `charges_enabled = true`, so their `approved` apps auto-hide. Active subscriptions continue billing the buyer until manual admin action (refund/cancel) — this is intentional, not a bug. New subscriptions to that vendor's apps are blocked by the same listing filter.
- **Churn detection:** a monthly job flags any vendor whose just-ended-month cancellation rate exceeds `CHURN_ALERT_THRESHOLD_BPS` (env, default 2000 = 20%). Alert admin via Resend — possible poaching / in-app email capture.
- Access JWT expiry ≤ 5 min; signed with the platform private key (`kid`), verified via JWKS.
- All payouts run via Stripe Connect transfers; the platform never holds or moves funds manually.
- Every money or access event writes an `audit_log` row.

## 9. Build order
**Phase 0 — Foundation:** #1 setup/auth/roles/test-harness/env-validation.
**Phase 1 — MVP:** #2 schema → #3 marketplace → #4 vendor dashboard → #5 Connect onboarding + product/price → #6 subscribe + webhooks + entitlements → #7 hybrid pricing tiers + monthly cron → #8 anonymous token access → #9 buyer dashboard → #10 admin dashboard → #11 testing & security hardening → #12 observability & Stripe↔DB reconciliation.
**Phase 2:** #13 affiliate role + referral links + 50% split → #14 reseller role + $19/mo subscription + storefront offers + 5% platform fee.

See `BUILD_PROMPTS.md` for the index, or open the individual file in `build_prompts/` (e.g. `build_prompts/01-project-setup.md`) for the exact prompt and Verify step.

## 10. Non-goals (for now)
- No white-label / rebranding.
- No SSO or iframe embedding (redirect + token only).
- No heavy legal contract; a minimal ToS forbids in-app email capture.
- No multi-currency, no free trials, no automated tax/VAT handling (note as future work — taxes can bite for EU buyers).

## 11. Money-flow architecture (Separate Charges & Transfers)
The platform is the merchant of record. Each app maps to a Stripe **Product + recurring Price** on the platform account, created when the app is approved. Each reseller offer maps to its **own** recurring Price (still on the platform account) reflecting the reseller's markup.

1. Buyer subscribes → Stripe **Subscription on the platform account** (buyer is a Stripe Customer on the platform). One Stripe Customer per buyer, reused across subscriptions. The Subscription uses the **app's** Price for direct/affiliate sales and the **offer's** Price for reseller-sold sales.
2. Each cycle, `invoice.paid` fires → the platform fans out transfers based on the subscription's attribution:
   All transfer amounts are computed on `net` = `balance_transaction.net` (after Stripe processing fee). Tier bracket evaluation (for selecting `cut_bps`) uses `gross` = `invoice.amount_paid`.
   - **Direct sale (no affiliate, no reseller):** one transfer to the vendor for `net × (10_000 − cut_bps) / 10_000`. Platform retains `net × cut_bps / 10_000`.
   - **Affiliate-attributed sale:** one transfer to the vendor for `net × (10_000 − 500 − affiliate_commission_snapshot_bps) / 10_000`. One transfer to the affiliate for `net × affiliate_commission_snapshot_bps / 10_000`. Platform retains a flat `net × 500 / 10_000` (5% of net). The vendor's tier-based `cut_bps` does **not** apply on affiliate sales; the platform always takes 5% and the affiliate gets their snapshotted %.
   - **Reseller-sold sale:** one transfer to the vendor for `vendor_floor_snapshot_cents` (fixed floor, snapshotted on the subscription row). A second transfer to the reseller for `markup_net × 95%` where `markup_net = net − vendor_floor_snapshot_cents`. Platform retains `markup_net × 5%`. Vendor's tier % is not applied here.
   Every transfer carries an idempotency key derived from `(invoice_id, recipient_role)` and uses `transfer_group`/`source_transaction` for traceability.
3. The **reseller's $19/mo subscription** is a normal Stripe Subscription **on the platform account** (no Connect transfers); `invoice.paid` for it updates `reseller_subscriptions.status` and gates new-business per §8.
4. On refund/dispute, transfers are reversed (§8) — for affiliate/reseller cases, ALL transfers for that invoice are reversed in one pass.

This pattern (not destination charges) is required because a single charge must fund **multiple** recipients (vendor + affiliate, or vendor + reseller) and because reversals must be precise per recipient.

Beyond the money-flow webhooks, the same endpoint handles `account.updated` (keeps `charges_enabled`/`payouts_enabled` in sync on `profiles`) and `account.application.deauthorized` (disables the vendor / reseller / affiliate — see §8). One webhook endpoint per environment receives both platform events and Connect events; Stripe Dashboard config: enable "Listen to events on Connected accounts" on the same endpoint to receive Connect events.

All connected accounts (vendor, affiliate, reseller) are configured for **weekly Friday payouts** via `payout_schedule: { interval: 'weekly', weekly_anchor: 'friday' }` set at Connect onboarding time.

## 12. Definition of done (per prompt)
Code compiles with strict TS, inputs validated with Zod, money/access paths have tests, RLS covers new tables and is tested, the prompt's Verify step passes, and the Progress checklist in `CLAUDE.md` is updated. See `ENGINEERING.md`.

## 13. Client ownership & provenance (`acquired_by`)
The anti-poaching boundary (§6, §7) is **not global** — it is governed by **who acquired the end client**, recorded once per subscription and immutable thereafter. This resolves the tension between the marketplace business (the platform brings buyers and protects them) and the usage-economy business (agencies bring their own clients and must own them — see §14).

- **`subscriptions.acquired_by`** (enum `platform | partner`, immutable after subscribe) is the single source of truth for the boundary.
- **`subscriptions.partner_owner_id`** (uuid → **organizations**, nullable; non-null **iff** `acquired_by='partner'`) names the **single** org that owns the client relationship (ownership is org-level, see §15 / build #47 — any member of that org may act for the client per their role). CHECK: `(acquired_by='partner') = (partner_owner_id IS NOT NULL)`.

### Boundary rules
- **`acquired_by='platform'`** — the platform acquired the buyer (the marketplace channel). The full §6/§7 anti-poaching boundary applies: every counterparty (vendor, reseller, affiliate) sees only `anon_user_id` and aggregate stats, never buyer PII. **This is the default for marketplace hosted apps (#1–#39) — unchanged.**
- **`acquired_by='partner'`** — a partner brought their own client (the usage-economy channel). The **`partner_owner_id`** party **owns and may see that client's identity** (their own customer). Anti-poaching does **not** apply between that one partner and their own client. **This is the default for usage-economy products (#40–#44): gateway agents, workflow templates, connector-backed automations.**

### What stays true in BOTH modes (non-negotiable)
- The **platform remains merchant of record**; all billing runs through the platform's Stripe (Separate Charges & Transfers, §11). Partner ownership of the *relationship* never means partner-owned billing.
- **Buyer card / payment data is NEVER exposed to anyone** but the platform + Stripe (PCI), regardless of `acquired_by`.
- **Ownership is singular.** Only the `partner_owner_id` party sees identity. **Every other counterparty in the value chain still sees `anon_user_id`.** Example: an agency (reseller) brings a client and sells a vendor's gateway agent → the *reseller* owns the client; the *vendor* still sees only `anon_user_id` (the vendor did not acquire this client). The vendor anti-poaching boundary therefore holds even in partner mode.
- **Role cannot self-set ownership.** `acquired_by` / `partner_owner_id` are written only by the service role at subscribe time, from the attribution context (e.g. partner-acquired via a partner's own checkout/SDK). A user can never elevate their own visibility into a client they did not acquire.

### Why scoped, not a per-subscription toggle
Provenance is decided **once, by the acquisition context**, not flipped later. The two product lines simply carry different defaults — there is no runtime UI toggle and no dual RLS regime per row beyond reading `acquired_by`. Keep one boundary code path that branches on this column; do not fork the stats views.

> §14 is reserved for "Usage metering & credits" (added when build #40 ships).

## 15. Organizations & ownership (multi-seat)
Built in #47. The unit of ownership, billing, and payout is an **organization**, not a bare user — agencies/resellers/vendors are teams.

- **Every user has exactly one personal org** (auto-created at signup, `type='personal'`). Teams are orgs with more than one member. A personal account is just a one-member org, so ownership is **uniformly `org_id`** — there is no "user-or-org" polymorphism anywhere.
- **`organizations`** holds the Stripe Connect account + `charges_enabled`/`payouts_enabled` (payouts go to the org, not the individual). The reseller `$19/mo` and WL subscriptions bill the org.
- **`org_members`** (`role`: `owner|admin|member`) governs in-app permissions: `owner` = billing + payouts + delete + transfer; `admin` = manage products/members; `member` = operate (run workflows, view), no billing. `profiles.role` remains the user's **platform** role (admin/vendor/buyer/affiliate/reseller) for capabilities; intra-work permissions come from `org_members.role`.
- **All product/money/data ownership references `org_id`**: apps, reseller_offers, affiliate_links, usage_meters, provider_keys, connector_accounts, workflows, metered products, credit_wallets, partner_clients, api_keys, and the Connect-bearing path. RLS checks membership via `is_org_member(org_id, min_role)`, not `user_id`.
- The **anti-poaching boundary (§6, §7, §13)** is unchanged in spirit, now expressed in org terms: a *vendor* is "a member of the vendor org," and no org gets a path to buyer PII it did not acquire. `partner_owner_id` (§13) is the owning org, making a client book a **shared team asset**.
- **Pre-launch migration:** existing single-user ownership backfills to each user's personal org (no live data; clean-break OK).
