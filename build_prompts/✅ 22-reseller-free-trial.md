# Task #22 — 30-day free trial on reseller $19/mo plan

**Wave 1 — quick win. Depends on: nothing. Blocks: nothing. Parallel-able with #20.** See `00-EXECUTION-ORDER.md`.

## Context
Currently a reseller pays $19/mo from day 1 (SPEC §4b). This adds friction to signup. Adding a 30-day trial reduces signup resistance: resellers who don't generate sales auto-churn, those who do will continue paying.

The reseller's gating (publishing offers, taking new sales) is per `reseller_subscriptions.status IN ('active','trialing')`. The status enum already includes `trialing` — no schema change needed.

## What changes

### Stripe Dashboard / Setup
On the reseller's $19/mo platform Price (`STRIPE_RESELLER_PLAN_PRICE_ID` env), no change to the Price itself. The trial is applied at subscription creation time, not on the Price.

### app/api/reseller/setup/route.ts — POST handler
Find the call to `stripe.checkout.sessions.create({ mode: 'subscription', ... })` (or equivalent `stripe.subscriptions.create`). Add `trial_period_days: 30`:
```ts
const checkoutSession = await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: process.env.STRIPE_RESELLER_PLAN_PRICE_ID!, quantity: 1 }],
  subscription_data: {
    trial_period_days: 30,
    metadata: { reseller_id: userId, plan: 'reseller_monthly' },
  },
  customer: stripeCustomerId,
  success_url: `${appUrl}/reseller?welcome=1`,
  cancel_url: `${appUrl}/reseller/setup?canceled=1`,
});
```

### lib/stripe/webhook-handlers.ts
The existing `customer.subscription.created/updated` handler for the reseller plan already maps Stripe statuses including `trialing` to `reseller_subscriptions.status`. Confirm — should be no-op.

Verify the gate function (`canPublishOffers`/`canTakeNewSales` — search the codebase) treats `trialing` the same as `active`. Per SPEC §8 it should already.

### app/reseller/setup/page.tsx — UI
Update the CTA: "Start 30-day free trial — $19/mo after trial". Make the trial explicit.

After trial conversion (Stripe fires `invoice.paid` for the first real charge), no special UI change needed.

### Trial cancellation
If a reseller cancels during the trial (`cancel_at_period_end=true` set during trial → Stripe handles this), their subscription transitions to `canceled` at trial end. They never get charged. This is the desired behavior — no extra code.

### Anti-abuse — limit trials per identity
Without a limit, a reseller could create N accounts and chain trials. Mitigations:
- Stripe Customer per email (already de-duped via auth.users).
- Add a check: before creating a new trial, query `reseller_subscriptions` for any prior row for this user. If one exists in any state, skip the trial (`trial_period_days: 0`).
```ts
const { data: prior } = await admin
  .from('reseller_subscriptions')
  .select('id')
  .eq('reseller_id', userId)
  .maybeSingle();
const trialDays = prior ? 0 : 30;
```

### Tests
`lib/stripe/__tests__/` — add a test confirming trial is offered to first-time resellers and skipped for returning ones.

## Verify
1. New user signs up as reseller → checkout shows "30-day free trial, then $19/mo" → Stripe Subscription created with `status='trialing'`.
2. `reseller_subscriptions.status = 'trialing'` after webhook.
3. Reseller can publish offers immediately (gate passes for trialing).
4. After 30 days, Stripe auto-charges $19 → status flips to `active` → no UI change.
5. Same user cancels and resubscribes → no second trial offered (charged from day 1).

## Caution
- The trial is configured per subscription, not per Price. So existing reseller subs continue without trial (correct — they're already paying customers).
- Add `RESELLER_TRIAL_DAYS=30` to env validation (optional, defaults to 30) for easy tuning.
