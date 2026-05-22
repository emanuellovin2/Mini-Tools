# Task #24 — Built-in vendor analytics (MRR, churn, cohort retention, LTV)

**Wave 5 — sticky features. Depends on: #17 (uses `net_amount_cents`), #26 (Card + Table + Skeleton). Blocks: nothing.** See `00-EXECUTION-ORDER.md`.

## Context
Vendors need analytics. Today, vendor dashboard at `/vendor` shows basic stats (apps, sub counts). To make the platform sticky, give vendors what they'd pay $100-500/mo for on ChartMogul or Baremetrics — for free, baked in. The historical data lives in our DB; vendors can't take it with them.

### Metrics (per vendor, optionally per app)
1. **MRR** — sum of `subscriptions.price_cents` for `status IN ('active','trialing')` for vendor's apps, /100 to dollars.
2. **New MRR / Expansion MRR / Contracted MRR / Churned MRR (waterfall)** — month-over-month deltas.
3. **Subscriber count** — active subscribers per app, per period.
4. **Churn rate (logo + revenue)** — canceled subscriptions ÷ start-of-period active count, monthly.
5. **Cohort retention curve** — for each month's signup cohort, % still active at month 1, 2, 3, ...
6. **LTV (estimated)** — `avg_price / monthly_churn_rate` (simple cohort-agnostic estimate).
7. **ARPU** — MRR ÷ active subscriber count.

All data is in: `subscriptions`, `vendor_revenue_events` (from #12), `apps`. Vendor sees only their own data (RLS / view).

## What changes

### DB — views or RPCs

Create a view `vendor_metrics_monthly` (admin/service-role usable, RLS-protected to the vendor):
```sql
CREATE OR REPLACE VIEW vendor_metrics_monthly AS
SELECT
  a.vendor_id,
  date_trunc('month', vre.received_at) AS month,
  SUM(vre.net_amount_cents) AS revenue_cents,
  COUNT(DISTINCT vre.subscription_id) AS paying_subs
FROM vendor_revenue_events vre
JOIN apps a ON a.id = vre.app_id
GROUP BY a.vendor_id, date_trunc('month', vre.received_at);

ALTER VIEW vendor_metrics_monthly SET (security_invoker = true);
-- RLS via underlying tables; vendor sees only their own data.
```

Create an RPC for cohort retention:
```sql
CREATE OR REPLACE FUNCTION vendor_cohort_retention(p_vendor_id uuid)
RETURNS TABLE (cohort_month date, month_offset int, retained_count int, cohort_size int)
LANGUAGE sql
SECURITY DEFINER
AS $$
  -- cohort = subscriptions created in month X
  -- retained at offset N = those still active or had a payment in month X+N
  WITH cohorts AS (
    SELECT
      s.id,
      date_trunc('month', s.created_at)::date AS cohort_month
    FROM subscriptions s
    JOIN apps a ON a.id = s.app_id
    WHERE a.vendor_id = p_vendor_id
  ),
  payments_per_month AS (
    SELECT
      c.cohort_month,
      date_trunc('month', vre.received_at)::date AS payment_month,
      COUNT(DISTINCT c.id) AS retained
    FROM cohorts c
    JOIN vendor_revenue_events vre ON vre.subscription_id = c.id
    GROUP BY 1, 2
  )
  SELECT
    p.cohort_month,
    EXTRACT(MONTH FROM age(p.payment_month, p.cohort_month))::int AS month_offset,
    p.retained::int AS retained_count,
    (SELECT COUNT(*) FROM cohorts WHERE cohort_month = p.cohort_month)::int AS cohort_size
  FROM payments_per_month p
  ORDER BY p.cohort_month, month_offset;
$$;
```

Add a verification policy that the RPC only returns data for `auth.uid() = p_vendor_id`.

### lib/services/vendor.ts
Add functions:
```ts
export async function getVendorMRR(vendorId: string): Promise<{ mrr_cents: number; active_subs: number }>;
export async function getVendorMRRWaterfall(vendorId: string, months: number): Promise<MRRWaterfall[]>;
export async function getVendorChurnRate(vendorId: string, month: Date): Promise<number>; // bps
export async function getVendorCohortRetention(vendorId: string): Promise<CohortRow[]>;
export async function getVendorLTV(vendorId: string): Promise<{ avg_ltv_cents: number; method: string }>;
```

### app/vendor/_components/
Add components:
- `MRRCard.tsx` — current MRR with month-over-month delta
- `MRRWaterfallChart.tsx` — bar chart (new/expansion/churn/contraction)
- `CohortRetentionTable.tsx` — heatmap-style table, cohort_month × month_offset
- `ChurnRateCard.tsx` — current month vs trailing 3-month average
- `LTVCard.tsx` — estimated LTV with methodology note

Use a lightweight chart library (e.g., Recharts or visx — confirm none is already installed). Avoid heavy dependencies.

### app/vendor/page.tsx
Add a new section "Analytics" above the apps list. Default to MRR + churn + cohort. Add a per-app filter dropdown (default: all apps).

### Tests
- Compute MRR for a vendor with 5 active subs at $50 each → 25000 cents.
- Cohort retention with mocked data: cohort of 10 at month 0 → 8 active at month 1 → retained_count=8, cohort_size=10.
- Churn: 100 active at start of month, 5 canceled during month → churn rate 500 bps.
- RLS: vendor A cannot read vendor B's metrics via the RPC.

## Verify
1. Vendor dashboard shows MRR live (changes when a sub cancels in test).
2. Cohort retention table populates with at least 2 months of test data.
3. Per-app filter works.
4. Page loads in <500ms for a vendor with up to 1000 subscriptions (test with seeded data).

## Caution
- Cohort retention computation can be slow at scale. If vendor has 10k+ subs, the RPC may timeout. Add an index: `vendor_revenue_events(subscription_id, received_at)`. Consider materializing into a `vendor_cohort_retention_cache` table refreshed nightly if performance becomes an issue.
- "MRR" definition: includes trialing? Industry standard is no (trialing = $0 MRR), but you may include it. Document the choice in a `Methodology` link on the dashboard.
- Affiliate-attributed and reseller-sold subscriptions: include them in vendor MRR or not? Recommendation: INCLUDE affiliate (vendor receives revenue), EXCLUDE reseller-sold (vendor gets only floor, not full price → tracked separately as "Reseller floor revenue").
- Privacy: NO buyer-level data in metrics views. Aggregates only. The anti-poaching boundary (SPEC §6) is non-negotiable.
- LTV with low data is unreliable. Add a "data sparse" warning when vendor has < 6 months of data.
