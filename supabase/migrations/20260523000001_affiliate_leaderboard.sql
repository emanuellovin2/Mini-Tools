-- #25 Affiliate leaderboard + badges + public profiles

-- 1. New profile fields for affiliates
ALTER TABLE profiles
  ADD COLUMN affiliate_bio text CHECK (length(affiliate_bio) <= 500),
  ADD COLUMN affiliate_avatar_url text,
  ADD COLUMN affiliate_lifetime_mrr_cents bigint NOT NULL DEFAULT 0
    CHECK (affiliate_lifetime_mrr_cents >= 0);

-- 2. Update RLS: freeze affiliate MRR columns so users cannot self-inflate counters.
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid())
    AND (stripe_account_id IS NOT DISTINCT FROM
           (SELECT p.stripe_account_id FROM public.profiles p WHERE p.id = auth.uid()))
    AND (stripe_customer_id IS NOT DISTINCT FROM
           (SELECT p.stripe_customer_id FROM public.profiles p WHERE p.id = auth.uid()))
    AND charges_enabled =
           (SELECT p.charges_enabled FROM public.profiles p WHERE p.id = auth.uid())
    AND payouts_enabled =
           (SELECT p.payouts_enabled FROM public.profiles p WHERE p.id = auth.uid())
    AND affiliate_active_mrr_cents =
           (SELECT p.affiliate_active_mrr_cents FROM public.profiles p WHERE p.id = auth.uid())
    AND affiliate_lifetime_mrr_cents =
           (SELECT p.affiliate_lifetime_mrr_cents FROM public.profiles p WHERE p.id = auth.uid())
  );

-- 3. Static badge definitions (derived at query time, never stored per-affiliate)
CREATE TABLE affiliate_badges (
  id              text    PRIMARY KEY,
  display_name    text    NOT NULL,
  description     text    NOT NULL,
  threshold_kind  text    NOT NULL CHECK (threshold_kind IN ('lifetime_mrr', 'active_mrr', 'tenure_days')),
  threshold_value bigint  NOT NULL,
  icon_emoji      text,
  sort_order      int     NOT NULL
);

ALTER TABLE affiliate_badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "affiliate_badges_public_read" ON affiliate_badges FOR SELECT USING (true);

INSERT INTO affiliate_badges (id, display_name, description, threshold_kind, threshold_value, icon_emoji, sort_order) VALUES
  ('rookie',   'Rookie',   'Generated first $100 in MRR', 'lifetime_mrr', 10000,   '🌱', 10),
  ('silver',   'Silver',   'Hit $1k lifetime MRR',        'lifetime_mrr', 100000,  '🥈', 20),
  ('gold',     'Gold',     'Hit $5k lifetime MRR',        'lifetime_mrr', 500000,  '🥇', 30),
  ('platinum', 'Platinum', 'Hit $20k lifetime MRR',       'lifetime_mrr', 2000000, '💎', 40),
  ('hot',      'On Fire',  '$1k+ active MRR right now',   'active_mrr',   100000,  '🔥', 50),
  ('veteran',  'Veteran',  '1 year as an affiliate',      'tenure_days',  365,     '🏛️',60);

-- 4. Public leaderboard view (no auth required — slug IS NOT NULL is the opt-in mechanism)
CREATE OR REPLACE VIEW affiliate_leaderboard AS
SELECT
  p.id,
  p.slug,
  p.display_name,
  p.affiliate_avatar_url,
  p.affiliate_active_mrr_cents,
  p.affiliate_lifetime_mrr_cents,
  EXTRACT(DAY FROM (now() - p.created_at))::int AS tenure_days,
  RANK() OVER (ORDER BY p.affiliate_active_mrr_cents DESC)   AS active_rank,
  RANK() OVER (ORDER BY p.affiliate_lifetime_mrr_cents DESC) AS lifetime_rank
FROM profiles p
WHERE p.role = 'affiliate'
  AND p.slug IS NOT NULL
  AND p.affiliate_lifetime_mrr_cents > 0;

-- 5. Earned badges function — joins badge thresholds against live profile stats
CREATE OR REPLACE FUNCTION affiliate_earned_badges(p_affiliate_id uuid)
RETURNS SETOF affiliate_badges
LANGUAGE sql STABLE
AS $$
  SELECT b.* FROM affiliate_badges b, profiles p
  WHERE p.id = p_affiliate_id AND p.role = 'affiliate'
    AND (
      (b.threshold_kind = 'lifetime_mrr' AND p.affiliate_lifetime_mrr_cents >= b.threshold_value) OR
      (b.threshold_kind = 'active_mrr'   AND p.affiliate_active_mrr_cents   >= b.threshold_value) OR
      (b.threshold_kind = 'tenure_days'  AND EXTRACT(DAY FROM (now() - p.created_at)) >= b.threshold_value)
    )
  ORDER BY b.sort_order;
$$;

-- 6. Atomic lifetime MRR increment/decrement (called by webhook handler on invoice.paid / refund).
--    Uses GREATEST(0, …) so a refund can never push the counter below zero.
CREATE OR REPLACE FUNCTION increment_affiliate_lifetime_mrr(
  p_affiliate_id uuid,
  p_amount_cents  bigint
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE profiles
  SET affiliate_lifetime_mrr_cents = GREATEST(0, affiliate_lifetime_mrr_cents + p_amount_cents)
  WHERE id = p_affiliate_id AND role = 'affiliate';
$$;
