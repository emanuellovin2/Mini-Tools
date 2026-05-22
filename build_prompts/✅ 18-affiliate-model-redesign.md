# Task #18 — Affiliate model redesign: vendor-funded, tiered rates

**Wave 4 — affiliate redesign. Depends on: #17 (net amount), #26 (UI primitives for vendor calculator). Blocks: #19 (transfer metadata), #25 (reads `affiliate_active_mrr_cents`).** See `00-EXECUTION-ORDER.md`.

## Context
This is the largest change. The current affiliate model (SPEC §4a) has:
- Affiliate earns 50% of platform's tier cut; vendor share is UNCHANGED.
- Example: $100 sale, Tier 1 (20% cut) → vendor $80, platform $10, affiliate $10.

The new model completely changes who pays and how much:
- Vendor sets an `affiliate_commission_bps` per app (min 2000 bps = 20%).
- On each affiliate-attributed invoice: platform takes **5% of net amount** flat; affiliate gets their commission %; vendor gets the rest.
- Affiliate commission tier (based on MRR they generated):
  - < $5,000 MRR generated → 20% (standard, 2000 bps)
  - ≥ $5,000 MRR generated → 25% (2500 bps)
  - ≥ $20,000 MRR generated → 30% (3000 bps)
- Vendor dashboard shows a calculator: if vendor wants affiliate to get 20%, calculator shows total cost = 25% (20% affiliate + 5% platform). Affiliate sees only their 20%.

### New money flow example
- Net amount $97 (after Stripe fees), vendor set affiliate_commission_bps = 2000 (20% to affiliate)
- Platform fee: 5% × $97 = $4.85
- Affiliate gets: 20% × $97 = $19.40
- Vendor gets: $97 - $4.85 - $19.40 = $72.75

## What changes

### DB — new fields and migrations

#### apps table
Add column: `affiliate_commission_bps` (smallint, nullable, CHECK >= 2000 and <= 9500, default null).
- null = vendor has not opted in to affiliate distribution (or hasn't set a rate yet).
- When set, the app is eligible for affiliate referral.

Migration:
```sql
ALTER TABLE apps
  ADD COLUMN affiliate_commission_bps smallint
    CHECK (affiliate_commission_bps IS NULL OR (affiliate_commission_bps >= 2000 AND affiliate_commission_bps <= 9500));
```

#### subscriptions table
Add column: `affiliate_commission_snapshot_bps` (smallint, nullable).
- Snapshotted at subscribe time (like `vendor_floor_snapshot_cents` for resellers).
- Immutable after set. Used for all future invoice calculations for this subscription.
- Non-null iff `affiliate_id IS NOT NULL`.

Migration:
```sql
ALTER TABLE subscriptions
  ADD COLUMN affiliate_commission_snapshot_bps smallint;
-- Add CHECK: (affiliate_id IS NULL) = (affiliate_commission_snapshot_bps IS NULL)
```

#### affiliate MRR tracking — CLARIFICATION NEEDED
Screenshots say: "25% după 5000$ MRR generat, 30% după 20000$ MRR generat".

**"MRR generated" is ambiguous — two readings:**
1. **Cumulative lifetime revenue** brought in by this affiliate. Monotonically increasing. Simple counter.
2. **Current active MRR** = sum of monthly amounts of active subscriptions this affiliate brought in. Can go DOWN when subscriptions cancel.

These behave very differently. Reading (2) is the standard SaaS meaning of "MRR" but harder to maintain (requires recompute on every subscribe/cancel). Reading (1) is the easier counter but creates a permanent tier — once an affiliate hits $20k cumulative, they stay at 30% forever even if their active subscriptions are all canceled.

**Decided: reading (2) — current active MRR.**
- Add `affiliate_active_mrr_cents` to `profiles` (bigint, NOT NULL default 0).
- Recompute on:
  - Each `customer.subscription.updated` (status change) for affiliate-attributed subs.
  - Each `customer.subscription.deleted`.
  - Each subscribe action that sets `affiliate_id`.
  - A nightly safety job that does a full recompute (guards against drift).
  ```sql
  UPDATE profiles SET affiliate_active_mrr_cents = (
    SELECT COALESCE(SUM(s.price_cents), 0)
    FROM subscriptions s
    WHERE s.affiliate_id = profiles.id
      AND s.status IN ('active', 'trialing')
      AND (s.paused_until IS NULL OR s.paused_until <= now())  -- paused subs (#23) don't count
  ) WHERE role = 'affiliate';
  ```
- `getAffiliateCommissionBps(activeMrrCents)` reads this column to determine the affiliate's tier (20%/25%/30%).
- The tier is the MINIMUM a vendor can offer this affiliate. The vendor-set `apps.affiliate_commission_bps` is per-app, but when listing an offer for an affiliate, validate `>= affiliate's tier`. Existing subscriptions keep their snapshotted rate (`affiliate_commission_snapshot_bps`) — tier change does not retroactively apply.

### lib/stripe/transfers.ts

#### New: computeAffiliateSplit()
```ts
export function computeAffiliateSplit(
  netAmountCents: number,
  affiliateCommissionBps: number
): { vendorShareCents: number; platformFeeCents: number; affiliateShareCents: number } {
  const platformFeeCents = Math.floor((netAmountCents * 500) / 10_000); // 5% flat
  const affiliateShareCents = Math.floor((netAmountCents * affiliateCommissionBps) / 10_000);
  const vendorShareCents = netAmountCents - platformFeeCents - affiliateShareCents;
  if (vendorShareCents < 0)
    throw new Error(
      `computeAffiliateSplit: negative vendor share (net=${netAmountCents}, affiliateBps=${affiliateCommissionBps})`
    );
  return { vendorShareCents, platformFeeCents, affiliateShareCents };
}
```

#### New: getAffiliateCommissionBps(affiliateMrrCents)
```ts
export function getAffiliateCommissionBps(affiliateMrrGeneratedCents: number): number {
  if (affiliateMrrGeneratedCents >= 2_000_000) return 3000; // $20k+ → 30%
  if (affiliateMrrGeneratedCents >= 500_000)  return 2500; // $5k+  → 25%
  return 2000; // standard → 20%
}
```

#### Update: transferAffiliateShare()
Signature changes — now receives `affiliateShareCents` directly (pre-computed).
Remove the old `cutBps / 20_000` formula entirely.

#### Update: transferVendorShare() for affiliate-attributed invoices
For affiliate sales, vendor gets `vendorShareCents` from `computeAffiliateSplit()`, not `amount × (10_000 - cut_bps) / 10_000`.

### lib/stripe/webhook-handlers.ts — handleInvoicePaid()

Affiliate-attributed branch changes:
1. Look up `subscriptions.affiliate_commission_snapshot_bps` (snapshotted at subscribe time).
2. Call `computeAffiliateSplit(netAmountCents, snapshotBps)`.
3. Transfer vendor share (new amount).
4. Transfer affiliate share (new formula).
5. Update `profiles.affiliate_mrr_generated_cents += netAmountCents` for the affiliate (atomic RPC or direct update inside the transaction).

### app/api/[subscribe route] — snapshot at subscribe time
When creating a subscription with `affiliate_id`:
1. Fetch `apps.affiliate_commission_bps` for the app.
2. If null, treat as non-affiliate (no affiliate attribution even if cookie exists).
3. Snapshot it to `subscriptions.affiliate_commission_snapshot_bps`.

### app/vendor/ — dashboard calculator
Add a UI component (or update the existing app edit form) showing:
- Input: "Affiliate commission (%)" — min 20%, max 95%
- Calculator reads: "You will pay [affiliate%]% to the affiliate + 5% to the platform = [total%]% total per sale"
- The 5% platform fee is always shown automatically; vendor cannot set it below 20% affiliate.
- Saved as `affiliate_commission_bps` on the app row.

The affiliate dashboard shows their earned % WITHOUT the platform's 5% — affiliates see only what they receive.

### lib/stripe/__tests__/
Add new test file: `affiliate.test.ts` (may already exist from #13 — extend it):
- computeAffiliateSplit: correct 3-way split, negative vendor share throws
- getAffiliateCommissionBps: tier thresholds ($0, $4999, $5000, $19999, $20000)
- integer safety for all computations

### SPEC.md §4a
Completely rewrite the affiliate model section.

### Migrations checklist
- `apps.affiliate_commission_bps` column
- `subscriptions.affiliate_commission_snapshot_bps` column
- `profiles.affiliate_mrr_generated_cents` column (or new tracking table)

## Verify
```bash
npm run typecheck
npm test
```
Manual: subscribe via affiliate link → confirm vendor receives ~75% of net, affiliate ~20%, platform ~5% (with default 20% affiliate commission set by vendor).

## Caution
- The affiliate_commission_bps can be 0 if vendor wants to give all to affiliate (theoretically). The CHECK enforces >= 2000. If vendor sets 9500 bps (95%), vendor gets: net - 5% - 95% = net - 100% = 0. Technically valid but the vendor earns nothing. The UI should warn.
- The tier (20%/25%/30%) is computed at PAYOUT time based on the affiliate's accumulated MRR — this means an affiliate mid-subscription may jump tiers. The `affiliate_commission_snapshot_bps` is frozen at subscribe time and does NOT change with the affiliate's tier. Only NEW subscriptions get the higher-tier commission. This is the simplest correct implementation.
- `affiliate_mrr_generated_cents` counter must be updated inside the same DB transaction as the invoice processing to avoid drift.
- **Backward compatibility: CLEAN BREAK (decided).** Pre-launch platform. At migration:
  1. `UPDATE subscriptions SET affiliate_commission_snapshot_bps = 2000 WHERE affiliate_id IS NOT NULL AND affiliate_commission_snapshot_bps IS NULL;` — default any existing affiliate sub to 20%.
  2. Add NOT NULL constraint with the CHECK: `(affiliate_id IS NULL) = (affiliate_commission_snapshot_bps IS NULL)`.
  3. **Delete the old "50% of platform cut" code path entirely** from `transferAffiliateShare()`. Old formula must not survive — otherwise it's a foot-gun waiting to fire.
  4. No dual code paths. New formula only.

- `affiliate_commission_bps` upper bound: I wrote 9500 (95%). Reconsider — a vendor paying 95% to affiliate + 5% to platform earns $0 per sale. That's never desirable. Cap at **8000 (80%)** so vendor keeps at minimum 15% of net.
