-- #24: Vendor analytics — app_id + subscription_id on revenue events,
--      vendor_metrics_monthly view, vendor_cohort_retention RPC, perf indexes.

-- 1. Extend vendor_revenue_events with per-app / per-sub context (nullable for
--    backward compat with rows written before this migration).
ALTER TABLE public.vendor_revenue_events
  ADD COLUMN IF NOT EXISTS app_id          uuid REFERENCES public.apps(id)          ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE SET NULL;

-- 2. Indexes recommended by build prompt for cohort query performance.
CREATE INDEX IF NOT EXISTS vendor_revenue_events_sub_time_idx
  ON public.vendor_revenue_events (subscription_id, occurred_at)
  WHERE subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS vendor_revenue_events_app_idx
  ON public.vendor_revenue_events (app_id)
  WHERE app_id IS NOT NULL;

-- 3. vendor_metrics_monthly: revenue and unique-payer count per vendor × app × month.
--    security_invoker = true → RLS on vendor_revenue_events applies (vendor sees own rows).
CREATE OR REPLACE VIEW public.vendor_metrics_monthly AS
SELECT
  vre.vendor_id,
  vre.app_id,
  date_trunc('month', vre.occurred_at)::date  AS month,
  SUM(vre.net_amount_cents)                    AS revenue_cents,
  COUNT(DISTINCT vre.subscription_id)          AS paying_subs
FROM public.vendor_revenue_events vre
WHERE vre.net_amount_cents > 0     -- positive events only; refunds excluded from revenue view
GROUP BY vre.vendor_id, vre.app_id, date_trunc('month', vre.occurred_at);

ALTER VIEW public.vendor_metrics_monthly SET (security_invoker = true);

-- 4. vendor_cohort_retention: % of each month's signup cohort still paying at offset N.
--    Cohort = subscriptions created in month X (direct + affiliate; reseller-sold excluded
--    per analytics note — vendor receives floor, not full price on those).
--    Retention = distinct subscriptions that had a revenue event in month X+N.
--    SECURITY DEFINER so it can join through apps (vendor only supplies their own id via
--    the server-side wrapper — application layer enforces auth.uid() = p_vendor_id).
CREATE OR REPLACE FUNCTION public.vendor_cohort_retention(p_vendor_id uuid)
RETURNS TABLE (
  cohort_month   date,
  month_offset   int,
  retained_count int,
  cohort_size    int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH cohorts AS (
    SELECT
      s.id,
      date_trunc('month', s.created_at)::date AS cohort_month
    FROM public.subscriptions s
    JOIN public.apps a ON a.id = s.app_id
    WHERE a.vendor_id  = p_vendor_id
      AND s.reseller_id IS NULL   -- SPEC: exclude reseller-sold from vendor MRR analytics
  ),
  payments_per_month AS (
    SELECT
      c.cohort_month,
      date_trunc('month', vre.occurred_at)::date AS payment_month,
      COUNT(DISTINCT c.id)                        AS retained
    FROM cohorts c
    JOIN public.vendor_revenue_events vre ON vre.subscription_id = c.id
    WHERE vre.net_amount_cents > 0
    GROUP BY 1, 2
  )
  SELECT
    p.cohort_month,
    -- Full-year-aware offset: age() returns interval; extract year*12 + month
    (EXTRACT(YEAR  FROM age(p.payment_month, p.cohort_month))::int * 12 +
     EXTRACT(MONTH FROM age(p.payment_month, p.cohort_month))::int)  AS month_offset,
    p.retained::int                                                   AS retained_count,
    (SELECT COUNT(*) FROM cohorts c2 WHERE c2.cohort_month = p.cohort_month)::int AS cohort_size
  FROM payments_per_month p
  ORDER BY p.cohort_month, month_offset;
$$;

-- Only authenticated users may call this; server wrapper validates uid = p_vendor_id.
REVOKE EXECUTE ON FUNCTION public.vendor_cohort_retention(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.vendor_cohort_retention(uuid) TO authenticated;
