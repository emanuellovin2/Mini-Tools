# Prompt #6 — Subscribe, webhooks, and entitlements (source of truth)

> **Before starting:** read `SPEC.md` §6, §8, §11 and `ENGINEERING.md`.
> **Definition of Done:** strict TS, Zod at boundaries, tests on money/access paths, RLS + RLS tests for new tables, Verify step passes, Progress checklist ticked.
> **This is where correctness is won or lost.**

---

Build the money-in path and the reconciliation backbone.

- **Subscribe flow (server action or RPC):** from `/app/[id]`, create one Stripe **Customer per buyer** (reused, cache the id on `profiles.stripe_customer_id`), then a Stripe **Subscription on the platform account** via Checkout. Block subscribing if the buyer already has an active sub to that app (rely on the partial unique constraint + a friendly pre-check). Use an idempotency key. **Mint and store `anon_user_id` at this step**: query `SELECT anon_user_id FROM subscriptions WHERE buyer_id = $1 AND app_id = $2 ORDER BY created_at DESC LIMIT 1`; if a row exists, reuse that id; if not, generate `usr_` + 16 random bytes base62 (CSPRNG, e.g. `crypto.randomBytes(16)`). Insert the subscription row with `status='incomplete'` and the chosen `anon_user_id` **in the same transaction** as the Checkout session creation record. On return from Checkout, **do not** mark active off the redirect — show a "pending" state until the webhook confirms.
- **Webhook endpoint:** `runtime = 'nodejs'`, read the **raw body** (`req.text()`), **verify the signature first** (against `STRIPE_WEBHOOK_SECRET`), then upsert into `webhook_events` and process **once** (idempotent, safe for out-of-order/duplicate delivery). Each handler runs in a DB transaction that also writes `webhook_events.status='processed'` — if the handler throws, the transaction rolls back AND `webhook_events` stays in `received` so Stripe's retry will reprocess. Handle: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created/closed`, `account.updated`, **`account.application.deauthorized`** (set `charges_enabled=false`, `payouts_enabled=false` for that vendor — SPEC §8).
- **Entitlements:** the DB is the source of truth. Map Stripe status → `subscriptions.status` → access via the **single shared state-machine function** (SPEC §8) — used here AND by `/api/verify` in #8. Any unknown Stripe status throws (logged to `audit_log`), never silently defaults. Set `current_period_end`, `cancel_at_period_end`, `canceled_at` from events.
- **Transfers:** on `invoice.paid`, transfer the vendor share (`amount − amount × cut_bps / 10_000`) to the vendor's connected account, with an idempotency key (`transfer:invoice_<invoice_id>:vendor_<vendor_id>`) and a `transfer_group` for traceability. **Read `cut_bps` from a helper that defaults to Tier 1 (`cut_bps=2000`) when no `vendor_billing` row exists** (SPEC §8) — never crash, never 0%. On `charge.refunded` / dispute, **reverse** the transfer (idempotent — check if a reversal exists before creating one).
- Write an `audit_log` row for every money/access event in the same transaction as the state change.

## Verify

Use Stripe CLI `stripe listen` + `stripe trigger`:

- A test subscription completes and only becomes active after the webhook
- The row carries an `anon_user_id` from creation time
- A buyer who cancels and resubscribes to the same app gets the **same** `anon_user_id` on the new row
- Replaying the same event id does nothing the second time
- An out-of-order `updated`-before-`created` is handled
- `invoice.paid` produces exactly one vendor transfer of the right amount (Tier 1 cut for a brand-new vendor with no `vendor_billing` row)
- A refund reverses the transfer (and a duplicate refund event does NOT create a second reversal)
- A `past_due` subscription yields access = false
- `account.application.deauthorized` hides the vendor's apps from the marketplace immediately
- No buyer email/PII is ever written where a vendor could read it

Tests cover: the split math, the state machine (every row of the §8 table), webhook idempotency, and anon_user_id reuse.
