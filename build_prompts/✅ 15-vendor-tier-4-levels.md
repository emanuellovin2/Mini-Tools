# Task #15 — Vendor tier: 4 levels (12%/8%/5%/3%)

**Wave 2 — backend pricing. Depends on: nothing. Blocks: nothing strictly, but ship before #17 since they touch the same PL/pgSQL function.** See `00-EXECUTION-ORDER.md`.

## Context
Current model (SPEC §3) has 3 tiers: 20%/10%/5% at $0-1k / $1k-2k / $2k+.
New model: 4 tiers: 12%/8%/5%/3% at $0-1k / $1k-3k / $3k-10k / $10k+.
Applies ONLY to direct sales (not affiliate-attributed or reseller-sold — same as before).

## What changes

### lib/stripe/billing.ts
Replace `computeTier()`:
```ts
export interface TierResult {
  tier: 1 | 2 | 3 | 4;
  cut_bps: number;
}

export function computeTier(grossCents: number): TierResult {
  const gross = Math.max(0, grossCents);
  if (gross >= 1_000_000) return { tier: 4, cut_bps: 300 };   // $10k+
  if (gross >= 300_000)  return { tier: 3, cut_bps: 500 };    // $3k-$10k
  if (gross >= 100_000)  return { tier: 2, cut_bps: 800 };    // $1k-$3k
  return { tier: 1, cut_bps: 1_200 };                          // $0-$1k
}
```

Boundaries (lower inclusive, upper exclusive):
- Tier 1: gross < $1,000 → 12% (1200 bps)
- Tier 2: $1,000 ≤ gross < $3,000 → 8% (800 bps)
- Tier 3: $3,000 ≤ gross < $10,000 → 5% (500 bps)
- Tier 4: gross ≥ $10,000 → 3% (300 bps)

### supabase/migrations/YYYYMMDD_vendor_billing_tier_4.sql
**Confirmed:** `vendor_billing.tier` is `smallint CHECK (tier IN (1, 2, 3))` (see `20260521000003_schema.sql:174`). The CHECK must be updated:
```sql
ALTER TABLE vendor_billing DROP CONSTRAINT IF EXISTS vendor_billing_tier_check;
ALTER TABLE vendor_billing ADD CONSTRAINT vendor_billing_tier_check CHECK (tier IN (1, 2, 3, 4));
```

### 🚨 CRITICAL — second source of truth in SQL
The PL/pgSQL function in `20260522000003_vendor_revenue_events.sql` (lines 60-84) **duplicates** `computeTier()` in raw SQL:
```sql
-- Current (must be replaced):
IF v_gross >= 200000 THEN v_tier := 3; v_cut_bps := 500;
ELSIF v_gross >= 100000 THEN v_tier := 2; v_cut_bps := 1000;
ELSE v_tier := 1; v_cut_bps := 2000;
```

This is called by the monthly billing cron. If left unchanged, the TS code and SQL will disagree → wrong cut_bps written to `vendor_billing`. The new migration MUST replace this function body:
```sql
IF v_gross >= 1000000 THEN v_tier := 4; v_cut_bps := 300;
ELSIF v_gross >= 300000 THEN v_tier := 3; v_cut_bps := 500;
ELSIF v_gross >= 100000 THEN v_tier := 2; v_cut_bps := 800;
ELSE v_tier := 1; v_cut_bps := 1200;
END IF;
```

**Recommended cleanup (separate task or here):** drop the SQL duplication. Make the cron call a TS edge function that uses `computeTier()` directly, OR keep the SQL function but add a unit test that asserts SQL ↔ TS parity for representative inputs. Two sources of truth for money math is a bug magnet.

### lib/stripe/__tests__/billing.test.ts
Rewrite all boundary tests to match new 4-tier system:
- $0 → Tier 1, 1200 bps
- $999.99 (99_999 cents) → Tier 1
- $1000.00 (100_000 cents) → Tier 2, 800 bps
- $2999.99 (299_999 cents) → Tier 2
- $3000.00 (300_000 cents) → Tier 3, 500 bps
- $9999.99 (999_999 cents) → Tier 3
- $10000.00 (1_000_000 cents) → Tier 4, 300 bps
- negative gross → Tier 1

### supabase/functions/monthly-billing-cron/index.ts
No logic change needed — `computeTier()` is called there and the result is written to `vendor_billing.tier` + `vendor_billing.cut_bps`. The new tier 4 will just write `cut_bps: 300`. Confirm the function imports `computeTier` and doesn't hardcode tiers.

### SPEC.md §3
Update the tier table:
| Tier | Monthly gross | Platform cut |
|------|--------------|--------------|
| 1 | gross < $1,000 | 1200 bps (12%) |
| 2 | $1,000 ≤ gross < $3,000 | 800 bps (8%) |
| 3 | $3,000 ≤ gross < $10,000 | 500 bps (5%) |
| 4 | gross ≥ $10,000 | 300 bps (3%) |

Also update §8 default tier rule: "Tier 1 defaults (cut_bps = 1200)".

### lib/stripe/transfers.ts — getVendorCutBps()
Default fallback changes from 2000 to 1200:
```ts
return data?.cut_bps ?? 1_200;
```

### lib/stripe/__tests__/transfers.test.ts
Update the "defaults to 2000 (Tier 1)" test to expect 1200.
Update transfer math tests (Tier 1 now gives vendor 88%, not 80%).

## Verify
```bash
npm test -- --run lib/stripe/__tests__/billing.test.ts
npm test -- --run lib/stripe/__tests__/transfers.test.ts
npm run typecheck
```
All tests pass, typecheck clean.

## Caution
- `vendor_billing.tier` column type: if it's `smallint CHECK (tier IN (1,2,3))`, the CHECK must be updated to include 4.
- Existing `vendor_billing` rows with tier 1/2/3 remain valid — no data migration needed.
- The default tier fallback (no billing row) MUST use 1200, not 2000 — update `getVendorCutBps()`.
