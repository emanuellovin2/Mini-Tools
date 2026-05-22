# Task #16 — Reseller platform fee: 5% of markup (not 5% of gross)

**Wave 2 — backend pricing. Depends on: nothing. Blocks: nothing.** See `00-EXECUTION-ORDER.md`.

## Context
Current SPEC §4b: platform takes 5% of the gross sale price from the buyer.
New rule: platform takes 5% of the reseller's markup (sell_price - vendor_floor).

### Example comparison
- Buyer pays $50, vendor floor $40, markup = $10
- OLD: platform takes $2.50 (5% × $50), reseller gets $7.50
- NEW: platform takes $0.50 (5% × $10), reseller gets $9.50
- Vendor always gets $40 in both cases.

## What changes

### lib/stripe/transfers.ts — computeResellerSplit()
```ts
export function computeResellerSplit(
  amountCents: number,
  vendorFloorCents: number
): { vendorShareCents: number; platformFeeCents: number; resellerShareCents: number } {
  const markup = amountCents - vendorFloorCents;
  if (markup < 0)
    throw new Error(
      `computeResellerSplit: sell_price below vendor floor (amount=${amountCents}, floor=${vendorFloorCents})`
    );
  const platformFeeCents = Math.floor((markup * 500) / 10_000); // 5% of markup
  const resellerShareCents = markup - platformFeeCents;
  return { vendorShareCents: vendorFloorCents, platformFeeCents, resellerShareCents };
}
```

### lib/stripe/__tests__/transfers.test.ts (or entitlements if reseller split tested there)
Check lib/stripe/__tests__/ for existing reseller split tests. Update examples:
- amount=5000, floor=4000 → markup=1000 → platformFee=5 (5% of 1000), reseller=995, vendor=4000
- amount=5000, floor=5000 → markup=0 → platformFee=0, reseller=0, vendor=5000 (edge: no markup)
- amount=4000, floor=5000 → throws (sell below floor)
- Integer safety: floor() applied to markup × 500 / 10_000

### SPEC.md §4b
Update the split example and formula:
- Platform: `5% × (sell_price_cents − vendor_floor_snapshot_cents)` (5% of markup)
- Reseller: `(sell_price_cents − vendor_floor_snapshot_cents) × 95%` (95% of markup)
- Worked example: buyer pays $50, vendor floor $40, markup $10 → platform $0.50, reseller $9.50, vendor $40

### SPEC.md §11 money-flow architecture
Update the reseller-sold transfer description accordingly.

## Verify
```bash
npm test -- --run lib/stripe/__tests__/
npm run typecheck
```

## Caution
- If markup is $0 (reseller sets no markup over vendor floor), platform gets $0 and reseller gets $0. This is mathematically correct but economically useless — consider whether the offer creation validation should enforce `sell_price_cents > min_price_cents` (strict, not ≥). Currently it allows equal. No code change needed unless you want to enforce it.
- This significantly reduces platform revenue per reseller transaction compared to 5% of gross. Intended.
