# Prompt #13 — Affiliate role + referral links (Phase 2)

> **Before starting:** read `SPEC.md` §2, §4a, §7 (tables `affiliate_links`, `affiliate_attributions`, `subscriptions.affiliate_id`), §11.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

Add the **Affiliate** role. Affiliates bring buyers via referral links and earn **50% of the platform's tier cut** on every attributed transaction, for as long as the subscription stays active. They never see buyer identity or run checkouts.

Scope:

- **Schema migrations** for `affiliate_links` and `affiliate_attributions` exactly as in SPEC §7. RLS: an affiliate can read only their own links/attributions; service role writes attributions; vendors/buyers/resellers cannot read these tables.
- **Affiliate dashboard** (`/affiliate`) — Connect onboarding (Express), generate referral links (`POST /api/affiliate/links` → 8-char base62 `code`, optional `app_id`), copy-to-clipboard UI, and an **aggregate-only** stats view (`affiliate_stats` view): clicks, conversions, active attributed subscribers, MRR earned, cumulative payouts. **Never** expose buyer ids or emails to the affiliate.
- **Attribution capture:** on any visit to `/?aff=<code>` or `/marketplace?aff=<code>`, set a first-party HTTP-only cookie (`aff_code`, 30-day max-age, `SameSite=Lax`) **server-side** via middleware/proxy. Validate `code` exists; ignore unknown codes silently. Drop the cookie if the visitor is logged in AND `affiliate_id = current user id` (self-referral). Last-touch wins on overwrite.
- **Attribution recording:** at subscribe time, the subscribe API/route resolves the cookie → looks up `affiliate_links.code` → writes a `subscriptions.affiliate_id` and a single `affiliate_attributions` row (`UNIQUE(subscription_id)` makes this idempotent). If the buyer is the affiliate, drop the cookie + skip attribution. Clear the cookie post-subscribe.
- **Money split** in the `invoice.paid` handler — extend the shared transfer planner so that when `subscriptions.affiliate_id IS NOT NULL`, a second Connect transfer goes to the affiliate for `amount × cut_bps / 20_000` (= 50% of the platform's tier cut from §3). Vendor share stays at `amount × (10_000 − cut_bps) / 10_000` (vendor is **not** charged for the affiliate). Both transfers share a `transfer_group`. Idempotency keys: `${invoice_id}:vendor` and `${invoice_id}:affiliate`. On `charge.refunded` / dispute closed lost, reverse **both** transfers in one pass.
- **Lifecycle:** commission accrues each cycle while the subscription is `active|trialing`; **stops** when status transitions to a terminal state (`canceled`, `unpaid`, `incomplete_expired`). `cancel_at_period_end=true` alone does not stop accrual until the period actually ends.
- **Audit log:** every attribution write and every affiliate transfer (success or reversal) writes a row.

## Verify

In Stripe test mode: (a) a logged-out visitor opens `/?aff=<valid_code>` → cookie set; subscribes → `subscriptions.affiliate_id` populated + one `affiliate_attributions` row + cookie cleared; (b) `invoice.paid` produces **two** Connect transfers (vendor share + affiliate 50% of platform cut) with deterministic idempotency keys; (c) a self-referral attempt (logged-in user whose id matches the code's affiliate) drops the cookie and records no attribution; (d) an unknown code is ignored without error; (e) on `charge.refunded`, both transfers reverse; (f) commission continues on the next cycle while status is `active`/`trialing`, and stops on `canceled`; (g) the affiliate dashboard shows only aggregate stats — no buyer-level data is queryable from the affiliate's RLS. Money math is unit-tested for all three vendor tiers (20% → 10% affiliate, 10% → 5% affiliate, 5% → 2.5% affiliate, all of gross).
