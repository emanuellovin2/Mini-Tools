-- ============================================================
-- Migration #7: vendor_revenue_events + compute_vendor_billing RPC
-- ============================================================

-- Tracks per-vendor revenue captures (positive) and refunds/disputes (negative).
-- Written by webhook handlers; read only by the monthly billing cron.
CREATE TABLE public.vendor_revenue_events (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  -- positive = captured payment, negative = refund or dispute loss
  amount_cents     bigint      NOT NULL,
  -- true when the subscription was reseller-sold; these rows are excluded from tier computation
  is_reseller_sale bool        NOT NULL DEFAULT false,
  stripe_invoice_id text,
  stripe_charge_id  text,
  -- Stripe event id used as idempotency key: one row per event per vendor
  stripe_event_id   text       UNIQUE,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vendor_revenue_events_vendor_time_idx
  ON public.vendor_revenue_events (vendor_id, occurred_at);
CREATE INDEX vendor_revenue_events_invoice_idx
  ON public.vendor_revenue_events (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

-- RLS: service role writes; vendors read their own; admin reads all
ALTER TABLE public.vendor_revenue_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vendor_revenue_events_select_own"
  ON public.vendor_revenue_events FOR SELECT
  USING (vendor_id = auth.uid());

CREATE POLICY "vendor_revenue_events_select_admin"
  ON public.vendor_revenue_events FOR SELECT
  USING (public.get_current_user_role() = 'admin');

-- ============================================================
-- compute_vendor_billing(vendor_id, period_start, period_end)
--
-- Computes gross revenue (direct+affiliate, excl. reseller) for the given
-- calendar-month window, applies the tier boundary rules from SPEC §3,
-- and writes one vendor_billing row. Idempotent via ON CONFLICT DO NOTHING.
-- Each call is its own transaction so a failure on one vendor is isolated.
-- ============================================================
CREATE OR REPLACE FUNCTION public.compute_vendor_billing(
  p_vendor_id    uuid,
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
    AND occurred_at <  (p_period_end  + INTERVAL '1 day')::timestamptz;

  -- Tier boundaries from SPEC §3 (lower-inclusive, upper-exclusive)
  IF v_gross >= 200000 THEN
    v_tier := 3; v_cut_bps := 500;
  ELSIF v_gross >= 100000 THEN
    v_tier := 2; v_cut_bps := 1000;
  ELSE
    v_tier := 1; v_cut_bps := 2000;
  END IF;

  INSERT INTO public.vendor_billing
    (vendor_id, period_start, period_end, gross_revenue_cents, tier, cut_bps, computed_at)
  VALUES
    (p_vendor_id, p_period_start, p_period_end, v_gross, v_tier, v_cut_bps, now())
  ON CONFLICT (vendor_id, period_start) DO NOTHING;
END;
$$;
