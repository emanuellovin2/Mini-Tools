-- Refund handler writes net_amount_cents as a negative delta (mirroring amount_cents)
-- so the monthly tier cron's SUM(net_amount_cents) stays consistent across refunds.
-- The original CHECK from #17 forbade this; drop it so handleChargeRefunded can
-- insert refund rows. amount_cents has never had a non-negative constraint.
ALTER TABLE public.vendor_revenue_events
  DROP CONSTRAINT IF EXISTS vendor_revenue_events_net_nonneg;
