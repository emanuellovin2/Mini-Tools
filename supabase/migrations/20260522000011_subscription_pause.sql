-- #23: Subscription pause support
-- Adds paused_until + pause_started_at columns and updates vendor_subscription_stats
-- to surface 'paused' when paused_until > now().

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS paused_until     timestamptz,
  ADD COLUMN IF NOT EXISTS pause_started_at timestamptz;

-- Rebuild vendor_subscription_stats to derive 'paused' from paused_until.
-- Stripe keeps status='active' while pause_collection is set; we override via paused_until.
CREATE OR REPLACE FUNCTION public.vendor_subscription_stats()
RETURNS TABLE (
  app_id             uuid,
  anon_user_id       text,
  status             text,  -- 'paused' possible even when Stripe status=active
  price_cents        bigint,
  current_period_end timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    s.app_id,
    s.anon_user_id,
    CASE
      WHEN s.paused_until IS NOT NULL AND s.paused_until > now() THEN 'paused'
      ELSE s.status::text
    END AS status,
    s.price_cents,
    s.current_period_end
  FROM subscriptions s
  INNER JOIN apps a ON a.id = s.app_id
  WHERE a.vendor_id = auth.uid();
$$;
