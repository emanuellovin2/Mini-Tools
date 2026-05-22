# Task #20 — Payout schedule: weekly on Fridays for all Connect accounts

**Wave 1 — quick win. Depends on: nothing. Blocks: nothing. Parallel-able with #22.** See `00-EXECUTION-ORDER.md`.

## Context
Currently, Stripe Express accounts use Stripe's default automatic payout schedule (typically daily when balance is available, or as configured in Stripe Dashboard).
New rule: All vendor, affiliate, and reseller Connect accounts must have weekly payouts on Fridays.

## What changes

### lib/stripe/connect.ts
Find the functions that create or onboard Connect Express accounts for vendors, affiliates, and resellers (likely `createConnectOnboardingLink` or similar).

When creating a Stripe Express account (or after onboarding completion), set the payout schedule:
```ts
await stripe.accounts.update(accountId, {
  settings: {
    payouts: {
      schedule: {
        interval: 'weekly',
        weekly_anchor: 'friday',
      },
      debit_negative_balances: true, // recommended to handle transfer reversals
    },
  },
});
```

This call should be made:
1. At account creation time (if the platform creates the account before redirecting to onboarding).
2. OR in the `account.updated` webhook handler, when `charges_enabled` first becomes `true` (i.e., after the vendor/affiliate/reseller completes onboarding) — this is the safer approach since you can't always set schedule before the account holder completes identity verification.

### Recommended approach: set schedule in account.updated webhook handler
```ts
// In webhook handler for account.updated
if (event.data.object.charges_enabled && !previouslyChargesEnabled) {
  await stripe.accounts.update(accountId, {
    settings: {
      payouts: { schedule: { interval: 'weekly', weekly_anchor: 'friday' } },
    },
  });
}
```

### For existing accounts (already onboarded)
Run a one-time script to update payout schedule for all Connect accounts that already have `charges_enabled = true`:
```ts
// scripts/set-weekly-payouts.ts (run once, then delete)
const accounts = await admin.from('profiles')
  .select('stripe_account_id')
  .eq('charges_enabled', true)
  .not('stripe_account_id', 'is', null);

for (const { stripe_account_id } of accounts.data) {
  await stripe.accounts.update(stripe_account_id, {
    settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'friday' } } },
  });
}
```

### UI (optional)
Add a note in vendor/affiliate/reseller dashboards: "Payouts are processed every Friday."

## Verify
- In Stripe Dashboard (test mode), verify a connected Express account shows "Weekly on Friday" payout schedule after onboarding.
- `npm run typecheck`

## Caution
- Not all Stripe Express accounts support manual payout schedule configuration — depends on the country and account type. For US Express accounts this works fine. For international accounts, Stripe may restrict the schedule options.
- `debit_negative_balances: true` ensures Stripe can debit the Connect account if transfer reversals result in a negative balance. Without this, reversal failures could accumulate.
- The payout schedule only affects when funds move from Stripe to the vendor's bank account — it does NOT affect when you can initiate transfers to the Connect account. Transfers happen immediately on invoice.paid; the schedule only controls when Stripe moves those funds to the bank.
