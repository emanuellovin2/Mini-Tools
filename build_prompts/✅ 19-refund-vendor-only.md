# Task #19 — Refund policy: only vendor's transfer is reversed

**Wave 4 — refund policy. Depends on: #18 (consistent transfer metadata). Blocks: nothing.** See `00-EXECUTION-ORDER.md`.

## Context
Current SPEC §8: "on charge.refunded / charge.dispute.created/closed, reverse ALL corresponding transfers (vendor, affiliate, reseller)."
New rule: Only the vendor's transfer is reversed on refund. Platform and affiliate/reseller KEEP their commissions.

### Economic implication
When a buyer is refunded $100:
- The refund is paid from the platform's Stripe balance (platform is merchant of record).
- Currently: ALL transfers are reversed → vendor gives back their share, affiliate/reseller give back theirs → platform is whole.
- New: ONLY vendor's transfer is reversed → platform receives the vendor's share back, but has already paid the affiliate/reseller their cut and does NOT claw it back → platform absorbs the affiliate/reseller portion of the refund.

Example: $100 sale, vendor floor $40 (reseller sale), platform keeps $0.50, reseller gets $9.50.
On refund: vendor gives back $40. Platform refunds buyer $100 but only recovered $40 → platform net loss = $60 on this refund (reseller kept $9.50, buyer was refunded $100, platform recovered $40).

This is a deliberate business policy. The platform is choosing to absorb refund risk on behalf of affiliates/resellers.

## What changes

### lib/stripe/transfers.ts — reverseTransfers()

Rewrite to selectively reverse only the vendor's transfer:
```ts
export async function reverseTransfers({
  invoiceId,
  chargeId,
}: {
  invoiceId: string;
  chargeId: string;
}): Promise<void> {
  const stripe = getStripe();
  const transfers = await stripe.transfers.list({ transfer_group: `invoice_${invoiceId}` });

  for (const transfer of transfers.data) {
    if (transfer.reversed) continue;

    // Only reverse the vendor's transfer (identified by metadata type).
    // Affiliate and reseller transfers are NOT reversed per refund policy.
    const isVendorTransfer =
      transfer.metadata?.type === 'vendor_floor'   // reseller-sold vendor floor
      || (transfer.metadata?.vendor_id && !transfer.metadata?.type); // direct/affiliate vendor share

    if (!isVendorTransfer) continue;

    await stripe.transfers.createReversal(
      transfer.id,
      { metadata: { charge_id: chargeId, invoice_id: invoiceId, reason: 'refund_vendor_only' } },
      { idempotencyKey: `reversal:transfer_${transfer.id}:charge_${chargeId}` }
    );
  }
}
```

### Metadata tagging — prerequisite
For the above to work, transfers must carry consistent metadata to identify the recipient type.

Check existing `transferVendorShare()`, `transferAffiliateShare()`, `transferResellerVendorFloor()`, `transferResellerShare()`:
- Vendor direct/affiliate: metadata has `vendor_id` but no `type` field → add `type: 'vendor_share'`
- Vendor floor (reseller): metadata already has `type: 'vendor_floor'` ✓
- Reseller markup: metadata has `type: 'reseller_markup'` ✓
- Affiliate: metadata has `affiliate_id` ✓

Update `transferVendorShare()` to add `type: 'vendor_share'` to metadata.
Then the filter in `reverseTransfers()` becomes:
```ts
const isVendorTransfer = transfer.metadata?.type === 'vendor_share'
  || transfer.metadata?.type === 'vendor_floor';
```

### SPEC.md §8 — Refunds & disputes
Update: "reverse only the vendor's transfer(s). Platform fee and affiliate/reseller commissions are non-refundable — the platform absorbs these on refund."

### lib/stripe/__tests__/transfers.test.ts
Update `reverseTransfers` tests:
- When group has vendor + affiliate transfers: only vendor is reversed.
- When group has vendor + reseller markup transfers: only vendor_floor is reversed.
- Already-reversed transfers: still skipped.
- Idempotency key unchanged.

## Verify
```bash
npm test -- --run lib/stripe/__tests__/transfers.test.ts
npm run typecheck
```

## Caution
- The metadata `type` field must be added retroactively to new transfers only. Old transfers (created before this change) won't have `type: 'vendor_share'` — they have `vendor_id` with no type. Two options:
  a) Filter by: `transfer.metadata?.type === 'vendor_share' || (transfer.metadata?.vendor_id && !transfer.metadata?.affiliate_id && !transfer.metadata?.reseller_id)` — covers old transfers.
  b) Accept that old refunds may reverse all transfers (acceptable for a short transition period).
  Option (a) is safer.

- ✅ **Decided policy split (final):**
  - `charge.refunded` (voluntary refund) → **vendor-only reversal**. Platform absorbs affiliate/reseller cut.
  - `charge.dispute.closed` with outcome `lost` → **reverse ALL transfers** (vendor + affiliate + reseller). Caps platform's downside on dispute-heavy merchants.
  - `charge.dispute.created` → no reversal yet (funds held by Stripe in escrow). Wait for `closed` to act.
  - `charge.dispute.closed` with outcome `won` → no reversal needed (platform keeps funds).

  Implementation: two separate functions in `lib/stripe/transfers.ts`:
  ```ts
  reverseVendorOnly({ invoiceId, chargeId, reason })   // for refunds
  reverseAllTransfers({ invoiceId, chargeId, reason }) // for disputes lost
  ```
  Webhook handler routes by event type to the right function. Audit log records which policy was applied and why.

- The platform must maintain sufficient Stripe balance to cover refunds not backed by transfer reversals. Monitor via Stripe Dashboard balance alerts.
