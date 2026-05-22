-- #15: Expand vendor_billing tier from 3 levels to 4 (12%/8%/5%/3%)
-- New boundaries: <$1k / $1k-$3k / $3k-$10k / $10k+

-- 1. Widen the CHECK constraint to allow tier = 4
ALTER TABLE public.vendor_billing
  DROP CONSTRAINT IF EXISTS vendor_billing_tier_check;

ALTER TABLE public.vendor_billing
  ADD CONSTRAINT vendor_billing_tier_check CHECK (tier IN (1, 2, 3, 4));

-- 2. Replace the PL/pgSQL billing function with 4-tier logic.
--    Must match computeTier() in lib/stripe/billing.ts exactly.
CREATE OR REPLACE FUNCTION public.compute_vendor_billing(
  p_vendor_id   uuid,
  p_period_start date,
  p_period_end   date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gross   bigint;
  v_tier    smallint;
  v_cut_bps int;
BEGIN
  -- Cash-basis gross: sum non-reseller events in [period_start, period_end] (UTC, inclusive).
  -- GREATEST floors negative months at 0 (SPEC §3).
  SELECT GREATEST(0, COALESCE(SUM(amount_cents), 0))
  INTO v_gross
  FROM public.vendor_revenue_events
  WHERE vendor_id        = p_vendor_id
    AND is_reseller_sale = false
    AND occurred_at >= p_period_start::timestamptz
    AND occurred_at <  (p_period_end + INTERVAL '1 day')::timestamptz;

  -- 4-tier boundaries (lower-inclusive, upper-exclusive). Must mirror computeTier() in TS.
  IF v_gross >= 1000000 THEN
    v_tier := 4; v_cut_bps := 300;      -- $10k+  → 3%
  ELSIF v_gross >= 300000 THEN
    v_tier := 3; v_cut_bps := 500;      -- $3k-$10k → 5%
  ELSIF v_gross >= 100000 THEN
    v_tier := 2; v_cut_bps := 800;      -- $1k-$3k  → 8%
  ELSE
    v_tier := 1; v_cut_bps := 1200;     -- $0-$1k   → 12%
  END IF;

  INSERT INTO public.vendor_billing
    (vendor_id, period_start, period_end, gross_revenue_cents, tier, cut_bps, computed_at)
  VALUES
    (p_vendor_id, p_period_start, p_period_end, v_gross, v_tier, v_cut_bps, now())
  ON CONFLICT (vendor_id, period_start) DO NOTHING;
END;
$$;
