# Prompt #14 — Reseller role + $19/mo subscription + storefront offers (Phase 2)

> **Before starting:** read `SPEC.md` §2, §4b, §7 (`profiles.slug`, `apps.min_price_cents`, `reseller_offers`, `reseller_subscriptions`, `subscriptions.reseller_id`/`reseller_offer_id`/`vendor_floor_snapshot_cents`), §8 reseller-subscription gate + self-attribution rules, §11 reseller money flow.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

Add the **Reseller** role. Resellers pay $19/month for access to a sales dashboard, where they pick vendor-opted-in apps, set their own markup over each vendor's `min_price`, and publish offers under their own storefront slug. Platform takes a flat **5%** of every buyer charge processed via a reseller offer; vendor receives exactly their floor; reseller pockets the markup minus the 5%.

Scope:

- **Schema migrations** for `apps.min_price_cents`, `profiles.slug` (UNIQUE), `reseller_offers`, `reseller_subscriptions`, and the new columns/checks on `subscriptions` (`reseller_id`, `reseller_offer_id`, `vendor_floor_snapshot_cents`, mutual-exclusion check with `affiliate_id`). RLS:
  - `reseller_offers`: reseller can read/insert/update their own offers; admins read all; buyers read only `status='active'` rows for marketplace browsing; vendors can read offers referencing their own apps (audit transparency) but cannot modify them.
  - `reseller_subscriptions`: reseller reads their own row; service role writes from webhooks.
  - `subscriptions` reseller-sold rows: reseller reads a `reseller_sale_stats` RPC/view exposing `app_id`, `anon_user_id`, `status`, `price_cents`, `vendor_floor_snapshot_cents`, `current_period_end` for **their own offers** — never `buyer_id`.
- **Vendor opt-in:** vendor dashboard (#4) gets a "Allow resellers" toggle that sets `apps.min_price_cents` (default null = opt-out). UI enforces `min_price_cents <= price_cents`.
- **Reseller signup & $19/mo subscription:** new role selectable at signup (existing #1 form). A new `/reseller/setup` page collects a `slug` (lower-kebab, server-validated unique) and starts a Stripe **Checkout** for a $19/mo recurring Price on the platform account (not Connect). Webhooks `customer.subscription.created/updated/deleted` + `invoice.paid/payment_failed` write `reseller_subscriptions`. Until the row reaches `status IN ('active','trialing')`, the reseller dashboard shows only "complete payment to unlock".
- **Connect onboarding for payouts:** reseller must also onboard a Connect Express account (reuse the helper from #5) before any `reseller_offers.status='active'` allowed — `charges_enabled` not required but `payouts_enabled` is.
- **Offer CRUD** (`/reseller/offers`): list/create/edit/pause. Server enforces:
  - `sell_price_cents >= apps.min_price_cents` (snapshot into `vendor_floor_snapshot_cents` at insert)
  - `apps.min_price_cents IS NOT NULL` (vendor opted in)
  - `apps.vendor_id != reseller_id` (no self-resell of own apps)
  - reseller's `reseller_subscriptions.status IN ('active','trialing')` before flipping to `active`
  - one Stripe **Price** is created per offer (recurring, USD, matches subscriptions' interval); store `stripe_price_id` on the offer
- **Storefront page** (`/r/[reseller-slug]/[offer-slug]`) — public, renders the app + offer, "Subscribe" button starts a Stripe Checkout against the offer's Price. Reject the checkout if the buyer's user id equals the reseller's (self-resell).
- **Subscribe handler** (extension of #6): when the Subscription was created from an offer's Price, look up `reseller_offers` by `stripe_price_id` → set `subscriptions.reseller_id`, `reseller_offer_id`, `vendor_floor_snapshot_cents`. If `affiliate_id` was about to be set from a cookie, **clear it** (mutual exclusion).
- **Money split** in `invoice.paid`: extend the transfer planner — when `subscriptions.reseller_id IS NOT NULL`, plan two Connect transfers: vendor share = `vendor_floor_snapshot_cents`, reseller share = `amount − vendor_floor_snapshot_cents − (amount × 500 / 10_000)`. Platform retains `amount × 500 / 10_000`. **Vendor's tier % does not apply** here — read this branch BEFORE the tier lookup. Idempotency keys: `${invoice_id}:vendor`, `${invoice_id}:reseller`. On refund/dispute, reverse both transfers.
- **Reseller-sold revenue excluded from `vendor_billing.gross_revenue_cents`** (§3) — the monthly cron's gross query filters `WHERE reseller_id IS NULL`.
- **Reseller subscription lapse:** when `reseller_subscriptions.status` leaves `active|trialing`, set all that reseller's `reseller_offers.status='paused'`. Existing buyer subscriptions tied to those offers continue paying out the reseller normally until they end; only new sales are blocked.
- **Reseller dashboard:** $19/mo billing status, Connect status, offer list, MRR by offer, lifetime payouts, refund/dispute log — all sourced from the `reseller_sale_stats` view + own tables. No buyer-level data.
- **Audit log** entries on offer create/update/pause, $19/mo state transitions, and each reseller transfer / reversal.

## Verify

In Stripe test mode:
1. Vendor sets an app's `min_price_cents = 4000` (=$40); price stays at $5000.
2. Reseller signs up → onboards Connect → pays $19/mo → `reseller_subscriptions.status = active`.
3. Reseller creates an offer at `sell_price_cents = 5000` ($50). Trying `sell_price_cents = 3500` is rejected. Trying to create an offer for the reseller's own app (when role is also vendor) is rejected.
4. Buyer goes to `/r/<slug>/<offer-slug>` and subscribes. Subscription row has `reseller_id` set, `reseller_offer_id` set, `vendor_floor_snapshot_cents = 4000`, `affiliate_id = null` (even if an `?aff=` cookie was present).
5. On the first paid invoice ($50): two transfers fire — $40 to vendor, $7.50 to reseller; platform retains $2.50. Idempotency keys are stable. Replaying the webhook does not duplicate transfers.
6. A self-resell attempt (reseller logged in as buyer) is rejected at checkout creation.
7. `vendor_billing.gross_revenue_cents` for that vendor's just-ended month **excludes** the $50 reseller-sold charge.
8. Reseller's $19/mo card fails → `reseller_subscriptions.status = past_due`, all their offers flip to `paused`, the storefront returns 404 on those slugs; the existing buyer's invoice next cycle still produces both transfers (vendor + reseller) as before.
9. `charge.refunded` on a reseller-sold invoice reverses both transfers in one pass; platform's 5% is also retained as a negative on the platform balance.
10. RLS test: a reseller cannot select `buyer_id` from `subscriptions` for their own rows; an affiliate cannot select from `reseller_offers`; a vendor cannot edit a `reseller_offer` for their own app.
11. Money math is unit-tested across edge cases (sell_price = floor → reseller share = $0 minus 5% of gross, possibly negative — rejected at insert; very small markups with rounding).
