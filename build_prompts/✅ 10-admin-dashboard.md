# Prompt #10 — Admin dashboard

> **Before starting:** read `SPEC.md` §2, §8.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.

---

Build `/dashboard/admin`:

- Approve/reject controls for pending apps and vendors. **Approving an app triggers #5's Product/Price creation** and only succeeds if the vendor is charges-enabled.
- A table of all subscriptions and transactions (admin can see everything), and an **audit-log viewer** with filtering by `actor_id`, `entity_type`, time range.
- A **churn-detection** view flagging any vendor whose just-ended-month cancellation rate exceeds `CHURN_ALERT_THRESHOLD_BPS` (env, default 2000 = 20%). Cancellation rate = `canceled_in_month / active_at_period_start` for that vendor's apps. Send a Resend alert to admin when a vendor newly crosses the threshold (deduplicated per vendor per month).
- Headline platform stats — **GMV, MRR, total cut earned** — computed from cents (`bigint` math, never floats).
- A "Sync vendor Stripe status" button per vendor that calls `stripe.accounts.retrieve()` and refreshes `charges_enabled`/`payouts_enabled` — admin fallback when the `account.updated` webhook missed an event.

## Verify

Approving an app makes it appear in the public marketplace (and creates its Stripe Price); approving is blocked for a non-charges-enabled vendor; the churn flag triggers on the seeded multi-month canceled data above the threshold and lowering `CHURN_ALERT_THRESHOLD_BPS` triggers more vendors; admin receives exactly one Resend alert per newly-flagged vendor per month (re-running the check doesn't duplicate); stats reconcile against seed data; the audit log shows money/access events.
