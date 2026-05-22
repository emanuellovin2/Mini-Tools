# Prompt #12 — Observability & Stripe↔DB reconciliation

> **Before starting:** read `SPEC.md` §8, §11.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.
> **`RESEND_API_KEY` becomes required at boot starting from this prompt** — update the Zod schema accordingly.

---

Add the operational safety net.

- **Structured logging** for money/access flows and webhook processing (event id, outcome, latency), without logging PII or secrets.
- **Reconciliation job (daily cron, 02:00 UTC):** compare Stripe state to the DB and flag drift — subscriptions active in Stripe but not the DB (or vice versa), `invoice.paid` with no matching transfer, transfers not reversed after a refund, `vendor_billing` rows whose `fee_stripe_invoice_id` no longer resolves in Stripe. Surface results to admin via a `/dashboard/admin/reconciliation` view and a Resend digest email.
- **Transactional email (Resend):** subscription receipt to buyer, payment-failure/dunning notice, admin alerts for churn flags and reconciliation drift. Wrap Resend calls in a thin service so a Resend outage degrades to "logged but not sent", never crashes a webhook handler.

## Verify

Introducing a deliberate drift (e.g. a manual Stripe cancel without the webhook firing) is caught by the next reconciliation run; a failed payment triggers a dunning email in test mode; logs show webhook processing without leaking PII/secrets; a forced Resend outage (bad API key) does not break the subscribe or webhook paths.
