# Task #17 — Commission basis: net amount after Stripe processing fees

**Wave 2 — backend pricing. Depends on: #15 (same PL/pgSQL function). Blocks: #18 (affiliate split uses net), #24 (analytics sum net).** See `00-EXECUTION-ORDER.md`.

## Context
Current SPEC §3: "Stripe processing fees (≈2.9% + 30¢) are paid by the platform and absorbed from the platform cut. Vendor share is computed on the gross charge amount."
New rule: ALL commissions (vendor, affiliate, reseller) are computed from the net amount — the amount that actually arrives in the platform's Stripe balance after Stripe deducts its processing fee.

## What changes

### Where `net_amount` comes from
In the `invoice.paid` webhook, the invoice has a `charge` ID. The charge has a `balance_transaction` with a `net` field (in cents) = gross minus Stripe's processing fee.

The webhook handler must expand the balance_transaction to get net:
```ts
const charge = await stripe.charges.retrieve(chargeId, {
  expand: ['balance_transaction'],
});
const netAmountCents = (charge.balance_transaction as Stripe.BalanceTransaction).net;
```

Alternatively, the invoice object itself has `amount_paid`. The charge can be fetched from `invoice.charge`.

### lib/stripe/webhook-handlers.ts — handleInvoicePaid()
Current code passes `amountCents = invoice.amount_paid` (gross) to all transfer functions.
Change:
1. After confirming the invoice has a charge, fetch the charge with `balance_transaction` expanded.
2. Use `balanceTransaction.net` as `amountCents` for ALL transfer calculations.
3. Keep `invoice.amount_paid` only for audit_log "paid_amount_gross" metadata, not for math.

```ts
// Inside handleInvoicePaid, after verifying invoice.charge:
const charge = await stripe.charges.retrieve(invoice.charge as string, {
  expand: ['balance_transaction'],
});
const bt = charge.balance_transaction as Stripe.BalanceTransaction;
if (!bt || bt.object !== 'balance_transaction') {
  throw new Error(`No balance_transaction on charge ${charge.id}`);
}
const netAmountCents = bt.net; // use this everywhere instead of invoice.amount_paid
```

### Tier thresholds → GROSS. Commission math → NET. (Decided.)

This is a two-track design:
- **Tier determination** (which % bracket the vendor is in) sums **GROSS** (`invoice.amount_paid`). This is what buyers actually paid — the "real" volume.
- **Commission application** (the % is multiplied against what) uses **NET** (`balance_transaction.net`). This is what arrived in the platform's Stripe balance.

Implication: `vendor_billing.gross_revenue_cents` and the PL/pgSQL function `compute_vendor_billing` in `20260522000003_vendor_revenue_events.sql` are **UNCHANGED** — they continue summing gross from `vendor_revenue_events.amount_paid`. The tier-4 update from #15 still applies but doesn't affect basis.

### vendor_revenue_events — add net_amount_cents for analytics + audit
Even though tier sums use gross, store net per event for reconciliation and analytics (#24 vendor analytics will use it).
```sql
ALTER TABLE vendor_revenue_events ADD COLUMN net_amount_cents bigint;
UPDATE vendor_revenue_events SET net_amount_cents = amount_paid WHERE net_amount_cents IS NULL;
-- (Old rows: best approximation = gross. New rows after this task: real net.)
ALTER TABLE vendor_revenue_events ALTER COLUMN net_amount_cents SET NOT NULL CHECK (net_amount_cents >= 0);
```

### Webhook handler — what actually changes
In `handleInvoicePaid`:
1. After confirming charge exists, expand `balance_transaction` to get `net`.
2. Pass `bt.net` as `amountCents` to ALL transfer functions (`transferVendorShare`, `transferAffiliateShare`, `computeResellerSplit`, etc.).
3. Continue inserting into `vendor_revenue_events` with BOTH `amount_paid` (gross, for tier sums) AND `net_amount_cents` (for analytics).

The math for each transfer becomes:
- Direct vendor: `net × (10_000 - cut_bps) / 10_000` (where cut_bps comes from `vendor_billing`, still tier-driven by historical gross sums).
- Affiliate split: per #18 (uses net).
- Reseller split: vendor floor unchanged, platform 5% × markup of net, reseller gets the rest.

### Vendor tier thresholds
The tier thresholds in `computeTier()` (e.g., $1k, $3k, $10k) are now applied to NET revenue. This is a business decision that must be acknowledged: a vendor whose gross is $1,000 but net is ~$971 (after ~2.9% Stripe fee) would stay in Tier 1. Net thresholds effectively raise the gross revenue needed to advance tiers slightly.

### SPEC.md §3
Remove: "Stripe processing fees (≈2.9% + 30¢) are paid by the platform as merchant of record and absorbed from the platform cut."
Add: "All commissions are computed on the net amount — what remains after Stripe deducts its processing fee (≈2.9% + 30¢). The platform bears no additional Stripe fee absorption beyond what is already deducted at the source."

Update `gross_revenue_cents` field in §7 schema to be "net_revenue_cents" if renaming, or clarify it now represents net.

## Verify
```bash
npm run typecheck
npm test
```
Manual: confirm that in the webhook handler, a $100 invoice with a Stripe fee of ~$3.20 results in $96.80 net being passed to all transfer computations.

## Caution
- `balance_transaction.net` is only available after the charge is captured and settled. For `invoice.paid`, this should always be the case, but if Stripe doesn't include it (e.g., for free/zero invoices), the handler must gracefully skip or use amount=0.
- The balance_transaction expand adds one extra Stripe API call per invoice. This is unavoidable. It should be done inside the existing webhook try/catch.
- Zero-amount invoices (free plan/trial) have `amount_paid = 0` and may not have a charge — guard for `invoice.charge === null` before fetching.
- `vendor_revenue_events` from #12: check if it stores raw `amount_paid` or already stores net. If gross, add a `net_amount_cents` column via migration before this task.
- All existing tests that use hard-coded `amountCents` values will still pass because the test mocks bypass the Stripe API call. Integration tests would catch discrepancies.
