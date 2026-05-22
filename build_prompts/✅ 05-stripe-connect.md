# Prompt #5 — Stripe Connect onboarding + product/price objects

> **Before starting:** read `SPEC.md` §3, §5, §11 and `ENGINEERING.md`.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

Integrate Stripe Connect with **Express** accounts (capabilities: `card_payments`, `transfers`); the **platform is merchant of record**.

- Vendor onboarding: create the Connect account, surface the onboarding link in the vendor dashboard, and **cache `charges_enabled`/`payouts_enabled`** on `profiles`. The `account.updated` webhook that automates this cache update lands in #6 — for #5's purposes, refresh the flags via a **manual "Sync Stripe status" button on the vendor dashboard** that calls `stripe.accounts.retrieve()` and updates the row. This button stays useful as a fallback after #6 ships.
- When an app is **approved** (admin action wired in #10, but the function lives here, callable from a temporary admin SQL/Studio path until then) **and** the vendor is charges-enabled, create the Stripe **Product + recurring Price** and store `stripe_product_id`/`stripe_price_id` on the app. Editing an app's price creates a **new** Price (never mutate; existing subs keep their snapshot) and updates `apps.price_cents` + `apps.stripe_price_id` atomically in one transaction.
- All Stripe writes use idempotency keys (e.g. `acct_create:vendor_<vendor_id>`, `product_create:app_<app_id>`, `price_create:app_<app_id>:<price_cents>`). Keep Stripe calls in `lib/stripe/*`.
- Configure the Stripe webhook endpoint in Dashboard to also receive Connect events ("Listen to events on Connected accounts") — the same endpoint will handle both in #6.

## Verify

In Stripe test mode, a vendor completes Express onboarding and clicking "Sync Stripe status" flips `charges_enabled` to true on `profiles`; approving an app creates a Product + Price stored on the app row; re-running onboarding/approval is idempotent (no duplicate Stripe objects); editing the price creates a NEW `stripe_price_id` and leaves any existing subscription's snapshot unchanged.
