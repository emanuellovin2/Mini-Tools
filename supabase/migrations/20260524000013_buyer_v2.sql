-- =============================================================================
-- #35 — Buyer dashboard v2
-- =============================================================================

-- (A) subscription_cancel_reasons ----------------------------------------------
-- Stores the buyer's stated reason when cancelling. Vendor sees only aggregated
-- counts (no buyer_id) via a SECURITY DEFINER view; never raw rows.

CREATE TABLE IF NOT EXISTS public.subscription_cancel_reasons (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  uuid        NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  buyer_id         uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  app_id           uuid        NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  reason_code      text        NOT NULL CHECK (reason_code IN (
                                 'too_expensive',
                                 'not_using',
                                 'switched_product',
                                 'missing_feature',
                                 'bug_or_quality',
                                 'other'
                               )),
  comment          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scr_sub_unique UNIQUE (subscription_id)
);

CREATE INDEX IF NOT EXISTS scr_buyer_idx ON public.subscription_cancel_reasons (buyer_id);
CREATE INDEX IF NOT EXISTS scr_app_idx   ON public.subscription_cancel_reasons (app_id);

-- (B) RLS on subscription_cancel_reasons ---------------------------------------

ALTER TABLE public.subscription_cancel_reasons ENABLE ROW LEVEL SECURITY;

-- Buyer reads and writes own records
CREATE POLICY "scr_buyer_select" ON public.subscription_cancel_reasons
  FOR SELECT USING (buyer_id = auth.uid());

CREATE POLICY "scr_buyer_insert" ON public.subscription_cancel_reasons
  FOR INSERT TO authenticated
  WITH CHECK (buyer_id = auth.uid());

-- Admin full access
CREATE POLICY "scr_admin_all" ON public.subscription_cancel_reasons
  FOR ALL TO authenticated
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

-- (C) Vendor cancel reason aggregates (SECURITY DEFINER so no buyer_id leaks) -

CREATE OR REPLACE FUNCTION public.get_app_cancel_reason_counts(p_app_id uuid)
RETURNS TABLE (reason_code text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    reason_code,
    COUNT(*) AS count
  FROM   public.subscription_cancel_reasons
  WHERE  app_id = p_app_id
  GROUP BY reason_code
  ORDER BY count DESC;
$$;

-- (D) Upcoming charges RPC (avoids per-sub Stripe calls server-side) -----------
-- Returns the next charge date + amount from subscriptions.current_period_end.
-- Real Stripe upcoming invoice amounts are fetched client-side to keep this fast.

CREATE OR REPLACE FUNCTION public.get_buyer_upcoming_charges(p_buyer_id uuid)
RETURNS TABLE (
  subscription_id   uuid,
  app_name          text,
  app_logo_url      text,
  price_cents       bigint,
  currency          text,
  next_charge_at    timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id                          AS subscription_id,
    a.name                        AS app_name,
    a.logo_url                    AS app_logo_url,
    s.price_cents,
    s.currency,
    s.current_period_end          AS next_charge_at
  FROM   public.subscriptions s
  JOIN   public.apps          a ON a.id = s.app_id
  WHERE  s.buyer_id = p_buyer_id
    AND  s.status IN ('active', 'trialing')
    AND  s.cancel_at_period_end = false
    AND  (s.paused_until IS NULL OR s.paused_until <= now())
    AND  s.current_period_end >= now()
    AND  s.current_period_end <= now() + INTERVAL '30 days'
  ORDER BY s.current_period_end ASC;
$$;

-- (E) Spend history RPC (last N months from subscriptions — no Stripe call) ----

CREATE OR REPLACE FUNCTION public.get_buyer_spend_history(
  p_buyer_id uuid,
  p_months   int DEFAULT 6
)
RETURNS TABLE (month text, total_cents bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    TO_CHAR(ve.created_at, 'YYYY-MM') AS month,
    COALESCE(SUM(s.price_cents), 0)    AS total_cents
  FROM   generate_series(
           date_trunc('month', now()) - ((p_months - 1) || ' months')::interval,
           date_trunc('month', now()),
           '1 month'::interval
         ) AS ve(created_at)
  LEFT JOIN public.subscriptions s
    ON  s.buyer_id = p_buyer_id
    AND TO_CHAR(s.created_at, 'YYYY-MM') = TO_CHAR(ve.created_at, 'YYYY-MM')
    AND s.status IN ('active', 'trialing', 'canceled')
  GROUP BY month
  ORDER BY month ASC;
$$;
