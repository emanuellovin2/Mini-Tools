# Task #23 — Subscription pause (buyer freezes instead of canceling)

**Wave 5 — sticky features. Depends on: #26 (Modal + Button primitives). Blocks: nothing.** See `00-EXECUTION-ORDER.md`.

## Context
Today, a buyer's only churn option is "cancel at period end". This permanently ends the relationship. A "pause" option lets the buyer freeze billing AND access for up to 90 days, then auto-resume (or auto-cancel if not resumed).

This typically reduces churn by 30-50% because users who hit a busy month or temporary budget cut don't have to fully decide to leave.

### Behavior
- Buyer clicks "Pause" → confirms 30/60/90 day pause → Stripe subscription pauses (no billing) → access (token `active`) goes false → `anon_user_id` and any subscription metadata are PRESERVED.
- After pause window expires: subscription auto-resumes at next billing cycle (Stripe handles this), `active` goes back to true.
- During pause: buyer can click "Resume now" to end pause early.
- Vendor sees: subscription status flipped to `paused` via `vendor_subscription_stats`. They keep history (the same `anon_user_id`).

## Stripe mechanism

Stripe natively supports `pause_collection` on subscriptions:
```ts
stripe.subscriptions.update(subId, {
  pause_collection: {
    behavior: 'void', // no invoices generated during pause
    resumes_at: Math.floor(Date.now()/1000) + 30 * 86400,
  },
});
```

`behavior: 'void'` means no invoice is generated — billing simply skips. When `resumes_at` is reached, Stripe automatically resumes billing on the next cycle.

The Stripe subscription `status` itself stays `active` while `pause_collection` is set, but the relevant fact is `pause_collection != null`. We mirror this in our DB.

## What changes

### DB migration
The `subscription_status` enum already has `paused` (per SPEC §8 state machine). But Stripe's `subscription.status` does NOT flip to "paused" automatically when `pause_collection` is set. We need a derived flag.

Add to `subscriptions`:
```sql
ALTER TABLE subscriptions
  ADD COLUMN paused_until timestamptz,           -- null = not paused; set to resumes_at when paused
  ADD COLUMN pause_started_at timestamptz;       -- audit
```

Update the SPEC §8 state machine: a subscription with `paused_until > now()` returns `active = false` regardless of Stripe `status`. The shared `subscriptionStatusToAccess` function adds this check.

### lib/stripe/entitlements.ts
Update `subscriptionStatusToAccess` to also accept a pause check:
```ts
export function isAccessActive(sub: {
  status: SubscriptionStatus;
  paused_until: string | null;
}): boolean {
  if (sub.paused_until && new Date(sub.paused_until) > new Date()) return false;
  return subscriptionStatusToAccess(sub.status);
}
```
Replace all access checks (token mint, `/api/verify` DB re-read) with the new helper.

### lib/stripe/webhook-handlers.ts
On `customer.subscription.updated`, read `pause_collection` from the event:
```ts
const pauseUntil = sub.pause_collection?.resumes_at
  ? new Date(sub.pause_collection.resumes_at * 1000).toISOString()
  : null;
await admin.from('subscriptions').update({
  paused_until: pauseUntil,
  pause_started_at: pauseUntil && !existing.pause_started_at ? new Date().toISOString() : existing.pause_started_at,
}).eq('stripe_subscription_id', sub.id);
```

When `pause_collection` is cleared (resume), `paused_until` becomes null. The buyer's access flips back to true on next launch.

### app/buyer/actions.ts
Add Server Actions:
```ts
export async function pauseSubscriptionAction(subscriptionId: string, days: 30 | 60 | 90) { ... }
export async function resumeSubscriptionAction(subscriptionId: string) { ... }
```
Both wrap `stripe.subscriptions.update(...)` and refresh the buyer dashboard.

### app/buyer/_components/
Add `PauseButton.tsx` — modal with 30/60/90 day options, calls `pauseSubscriptionAction`. Shows "Resume" button if subscription is currently paused.

The existing `CancelButton.tsx` stays but gets a sibling Pause option.

### app/buyer/page.tsx
For each active subscription, show:
- If `paused_until > now`: badge "Paused until [date]" + "Resume now" button + "Cancel" button.
- If active and not paused: "Pause" dropdown (30/60/90) + "Cancel" button.

### Vendor visibility (`vendor_subscription_stats` view)
Update the view to include a derived status:
```sql
CREATE OR REPLACE VIEW vendor_subscription_stats AS
SELECT
  app_id, anon_user_id,
  CASE
    WHEN paused_until > now() THEN 'paused'
    ELSE status::text
  END AS status,
  price_cents, current_period_end
FROM subscriptions
WHERE app_id IN (SELECT id FROM apps WHERE vendor_id = auth.uid());
```
Vendor sees "paused" — same `anon_user_id` preserved.

### Tests
- Pause sets `paused_until`, access flips to false immediately.
- Resume clears `paused_until`, access flips to true.
- Vendor view shows "paused" status during pause.
- Subscription resuming after `paused_until` expires (mock time) reverts access.

## Verify
End-to-end:
1. Buyer pauses for 30 days → access denied on next launch → vendor sees "paused" → no invoice generated for the next cycle.
2. Buyer clicks "Resume now" before 30 days → access restored → next cycle bills normally.
3. Auto-resume after 30 days (test mode: advance Stripe clock) → status normalizes.

## Caution
- Pausing during a billing cycle does NOT refund the current period — the buyer already paid for it and keeps access until `current_period_end`. The pause kicks in AFTER `current_period_end`. Make this explicit in the UI: "Pause begins [date]". If you want immediate pause, you'd need to compute proration — skip for MVP.
- Affiliate/reseller commissions stop during pause (no invoices → no transfers). This is correct — commission only on actual paid invoices.
- Pause cap: limit to 90 days max in UI. After 90 days the buyer must resume or it auto-cancels (set up via cron checking `paused_until + 90 days` and canceling via Stripe).
- Edge case: buyer pauses then immediately cancels. Pause is irrelevant — cancellation takes precedence.
