-- #18 Affiliate model redesign: vendor-funded, tiered commission rates

-- 1. apps: vendor sets per-app affiliate commission (20–80%)
ALTER TABLE apps
  ADD COLUMN affiliate_commission_bps smallint
    CHECK (
      affiliate_commission_bps IS NULL OR
      (affiliate_commission_bps >= 2000 AND affiliate_commission_bps <= 8000)
    );

-- 2. subscriptions: snapshot the commission rate at subscribe time (immutable)
ALTER TABLE subscriptions
  ADD COLUMN affiliate_commission_snapshot_bps smallint;

-- 3. Backfill existing affiliate subscriptions with 20% default
UPDATE subscriptions
  SET affiliate_commission_snapshot_bps = 2000
  WHERE affiliate_id IS NOT NULL AND affiliate_commission_snapshot_bps IS NULL;

-- 4. Enforce consistency: both columns null for non-affiliate, both set for affiliate
ALTER TABLE subscriptions
  ADD CONSTRAINT affiliate_commission_consistency
  CHECK ((affiliate_id IS NULL) = (affiliate_commission_snapshot_bps IS NULL));

-- 5. profiles: track active MRR generated per affiliate (recomputed on status changes)
ALTER TABLE profiles
  ADD COLUMN affiliate_active_mrr_cents bigint NOT NULL DEFAULT 0;

-- 6. Seed active MRR for any existing affiliate subscriptions
UPDATE profiles
  SET affiliate_active_mrr_cents = (
    SELECT COALESCE(SUM(s.price_cents), 0)
    FROM subscriptions s
    WHERE s.affiliate_id = profiles.id
      AND s.status IN ('active', 'trialing')
  )
  WHERE role = 'affiliate';
