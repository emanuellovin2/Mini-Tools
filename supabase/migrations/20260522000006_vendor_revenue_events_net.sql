-- #17: Add net_amount_cents to vendor_revenue_events.
-- Stores the amount after Stripe processing fees for analytics (#24) and audit.
-- Tier thresholds continue to use amount_cents (gross). Commission math uses net.

ALTER TABLE public.vendor_revenue_events
  ADD COLUMN IF NOT EXISTS net_amount_cents bigint;

-- Back-fill existing rows: best approximation is gross (real net not available retroactively).
UPDATE public.vendor_revenue_events
  SET net_amount_cents = amount_cents
  WHERE net_amount_cents IS NULL;

ALTER TABLE public.vendor_revenue_events
  ALTER COLUMN net_amount_cents SET NOT NULL;

ALTER TABLE public.vendor_revenue_events
  ADD CONSTRAINT vendor_revenue_events_net_nonneg CHECK (net_amount_cents >= 0);
