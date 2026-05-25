-- =============================================================================
-- #44 — Usage-product distribution (metered marketplace + reseller/affiliate)
-- =============================================================================
-- Extends solutions with product_kind + metering columns so gateway agents
-- and workflow templates can be listed in the marketplace with per-unit pricing.
-- Resellers get a per-unit markup offer; affiliates earn a recurring % of the
-- platform fee per unit consumed. All splits flow through the #40 ledger.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE product_kind AS ENUM ('hosted', 'gateway', 'workflow_template');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE reseller_metered_offer_status AS ENUM ('draft', 'active', 'paused', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 1. solutions: metering columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.solutions
  ADD COLUMN IF NOT EXISTS product_kind    product_kind NOT NULL DEFAULT 'hosted',
  ADD COLUMN IF NOT EXISTS meter_id        uuid         REFERENCES public.usage_meters(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vendor_unit_price_cents  bigint CHECK (vendor_unit_price_cents IS NULL OR vendor_unit_price_cents >= 0),
  ADD COLUMN IF NOT EXISTS min_unit_price_cents     bigint CHECK (min_unit_price_cents IS NULL OR min_unit_price_cents >= 0);

-- Metered products must have a meter; hosted products must not.
ALTER TABLE public.solutions DROP CONSTRAINT IF EXISTS solutions_metered_requires_meter;
ALTER TABLE public.solutions
  ADD CONSTRAINT solutions_metered_requires_meter CHECK (
    (product_kind = 'hosted' AND meter_id IS NULL)
    OR (product_kind IN ('gateway', 'workflow_template') AND meter_id IS NOT NULL)
  );

-- Reseller floor: min_unit_price_cents required when product is resellable + metered
-- (enforced at app layer; DB only enforces non-negative)

-- Recreate apps view so SELECT * picks up new columns added to solutions
CREATE OR REPLACE VIEW public.apps WITH (security_invoker = true) AS SELECT * FROM public.solutions;

-- ---------------------------------------------------------------------------
-- 2. reseller_metered_offers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reseller_metered_offers (
  id                              uuid                          NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id                          uuid                          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reseller_id                     uuid                          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  solution_id                     uuid                          NOT NULL REFERENCES public.solutions(id) ON DELETE CASCADE,
  -- Per-unit sell price (what the buyer is charged per unit)
  sell_unit_price_cents           bigint                        NOT NULL CHECK (sell_unit_price_cents > 0),
  -- Snapshot of solutions.vendor_unit_price_cents at offer creation time (immutable)
  vendor_unit_floor_snapshot_cents bigint                       NOT NULL CHECK (vendor_unit_floor_snapshot_cents >= 0),
  status                          reseller_metered_offer_status NOT NULL DEFAULT 'draft',
  created_at                      timestamptz                   NOT NULL DEFAULT now(),
  updated_at                      timestamptz                   NOT NULL DEFAULT now(),

  -- sell price must exceed vendor floor (so reseller share > 0)
  CONSTRAINT reseller_metered_offers_sell_gt_floor
    CHECK (sell_unit_price_cents > vendor_unit_floor_snapshot_cents),
  -- one active metered offer per (reseller, solution)
  CONSTRAINT reseller_metered_offers_unique_active
    UNIQUE NULLS NOT DISTINCT (reseller_id, solution_id, status)
    DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS reseller_metered_offers_reseller_idx
  ON public.reseller_metered_offers (reseller_id);
CREATE INDEX IF NOT EXISTS reseller_metered_offers_solution_idx
  ON public.reseller_metered_offers (solution_id);
CREATE INDEX IF NOT EXISTS reseller_metered_offers_org_idx
  ON public.reseller_metered_offers (org_id);

-- ---------------------------------------------------------------------------
-- 3. subscriptions: per-unit price snapshot for metered reseller offers
-- ---------------------------------------------------------------------------
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS sell_unit_price_snapshot_cents bigint
    CHECK (sell_unit_price_snapshot_cents IS NULL OR sell_unit_price_snapshot_cents > 0),
  ADD COLUMN IF NOT EXISTS reseller_metered_offer_id uuid
    REFERENCES public.reseller_metered_offers(id) ON DELETE SET NULL;

-- reseller_metered_offer_id implies reseller_id is set
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_metered_offer_requires_reseller;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_metered_offer_requires_reseller CHECK (
    reseller_metered_offer_id IS NULL OR reseller_id IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- 4. Quota column for reseller_metered_offers (default 50 per org)
-- ---------------------------------------------------------------------------
ALTER TABLE public.org_quotas
  ADD COLUMN IF NOT EXISTS max_reseller_metered_offers int NOT NULL DEFAULT 50;

-- ---------------------------------------------------------------------------
-- 5. RLS: reseller_metered_offers
-- ---------------------------------------------------------------------------
ALTER TABLE public.reseller_metered_offers ENABLE ROW LEVEL SECURITY;

-- Reseller (org member) can see/manage their org's metered offers
CREATE POLICY reseller_metered_offers_org_member ON public.reseller_metered_offers
  FOR ALL
  USING (is_org_member(org_id))
  WITH CHECK (is_org_member(org_id));

-- Public read for active offers (storefronts need to show pricing)
CREATE POLICY reseller_metered_offers_public_read ON public.reseller_metered_offers
  FOR SELECT
  USING (status = 'active');

-- ---------------------------------------------------------------------------
-- 6. Update list_marketplace_apps RPC — add product_kind, vendor_unit_price_cents, meter_unit
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_marketplace_apps(text, text, integer, integer);
CREATE OR REPLACE FUNCTION public.list_marketplace_apps(
  p_search          text    DEFAULT NULL,
  p_category        text    DEFAULT NULL,
  p_page            int     DEFAULT 1,
  p_page_size       int     DEFAULT 24,
  p_sort            text    DEFAULT 'trending',
  p_price_min       int     DEFAULT NULL,
  p_price_max       int     DEFAULT NULL,
  p_rating_min      numeric DEFAULT NULL,
  p_has_affiliate   bool    DEFAULT NULL,
  p_has_trial       bool    DEFAULT NULL,
  p_product_kind    text    DEFAULT NULL   -- 'hosted' | 'gateway' | 'workflow_template'
)
RETURNS TABLE (
  id                       uuid,
  name                     text,
  description              text,
  category                 text,
  price_cents              bigint,
  currency                 text,
  vendor_name              text,
  screenshot_urls          text[],
  rating_avg               numeric,
  rating_count             int,
  affiliate_commission_bps smallint,
  has_free_trial           bool,
  subscriber_count         bigint,
  product_kind             text,
  vendor_unit_price_cents  bigint,
  meter_unit               text,
  total_count              bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filtered AS (
    SELECT
      a.id,
      a.name,
      a.description,
      a.category,
      a.price_cents,
      a.currency,
      a.created_at,
      p.display_name                               AS vendor_name,
      a.screenshot_urls,
      a.rating_avg,
      a.rating_count,
      a.affiliate_commission_bps,
      a.has_free_trial,
      COALESCE(s.active_subs, 0)                   AS subscriber_count,
      a.product_kind::text                         AS product_kind,
      a.vendor_unit_price_cents,
      um.unit                                      AS meter_unit
    FROM   public.apps     a
    JOIN   public.profiles p ON p.id = a.vendor_id
    LEFT JOIN public.usage_meters um ON um.id = a.meter_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS active_subs
      FROM   public.subscriptions sub
      WHERE  sub.app_id = a.id
        AND  sub.status IN ('active', 'trialing')
        AND  sub.reseller_id IS NULL
    ) s ON true
    WHERE  a.status = 'approved'
      AND  p.charges_enabled = true
      AND  (p_category      IS NULL OR a.category       = p_category)
      AND  (p_price_min     IS NULL OR a.price_cents    >= p_price_min)
      AND  (p_price_max     IS NULL OR a.price_cents    <= p_price_max)
      AND  (p_rating_min    IS NULL OR a.rating_avg     >= p_rating_min)
      AND  (p_product_kind  IS NULL OR a.product_kind::text = p_product_kind)
      AND  (
            p_has_affiliate IS NULL
            OR (p_has_affiliate = true  AND a.affiliate_commission_bps > 0)
            OR (p_has_affiliate = false
                AND (a.affiliate_commission_bps IS NULL
                     OR a.affiliate_commission_bps = 0))
           )
      AND  (p_has_trial     IS NULL OR a.has_free_trial  = p_has_trial)
      AND  (
            p_search IS NULL
            OR to_tsvector('english', a.name || ' ' || COALESCE(a.description, ''))
                 @@ plainto_tsquery('english', p_search)
            OR a.name ILIKE '%' || p_search || '%'
           )
  ),
  counted AS (
    SELECT *, COUNT(*) OVER () AS total_count FROM filtered
  )
  SELECT
    id, name, description, category, price_cents, currency,
    vendor_name, screenshot_urls, rating_avg, rating_count,
    affiliate_commission_bps, has_free_trial, subscriber_count,
    product_kind, vendor_unit_price_cents, meter_unit,
    total_count
  FROM counted
  ORDER BY
    CASE p_sort
      WHEN 'price_asc'
        THEN LPAD(price_cents::text, 15, '0')
      WHEN 'price_desc'
        THEN LPAD((999999999 - price_cents)::text, 15, '0')
      WHEN 'rating'
        THEN LPAD((ROUND(rating_avg * 100))::text, 10, '0') || LPAD((rating_count)::text, 10, '0')
      WHEN 'newest'
        THEN TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS.US')
      ELSE
        LPAD(
          (subscriber_count * 10 + EXTRACT(EPOCH FROM created_at)::bigint / 86400)::text,
          20, '0'
        )
    END DESC NULLS LAST,
    name ASC
  LIMIT  p_page_size
  OFFSET ((p_page - 1) * p_page_size);
$$;

-- ---------------------------------------------------------------------------
-- 7. get_reseller_metered_earnings RPC — used by reseller dashboard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_reseller_metered_earnings(
  p_reseller_id uuid,
  p_days        int DEFAULT 30
)
RETURNS TABLE (
  solution_id       uuid,
  solution_name     text,
  units_sold        bigint,
  markup_cents      bigint,
  reseller_share_cents bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    sol.id                          AS solution_id,
    sol.name                        AS solution_name,
    SUM(ue.quantity)::bigint        AS units_sold,
    SUM(ue.reseller_share_cents + (ue.platform_share_cents
        -- Subtract base platform fee (vendor_unit_price already covers vendor share)
        -- Approximate: reseller_share + platform_cut_on_markup = total markup
        -- We just report reseller_share here
    ))::bigint                       AS markup_cents,
    SUM(ue.reseller_share_cents)::bigint AS reseller_share_cents
  FROM public.usage_events ue
  JOIN public.subscriptions sub ON sub.id = ue.subscription_id
  JOIN public.solutions sol ON sol.meter_id = ue.meter_id
  WHERE sub.reseller_id = p_reseller_id
    AND ue.reseller_share_cents IS NOT NULL
    AND ue.created_at >= now() - make_interval(days => p_days)
  GROUP BY sol.id, sol.name
$$;

-- ---------------------------------------------------------------------------
-- 8. get_affiliate_usage_earnings RPC — used by affiliate dashboard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_affiliate_usage_earnings(
  p_affiliate_id uuid,
  p_days         int DEFAULT 30
)
RETURNS TABLE (
  solution_id          uuid,
  solution_name        text,
  units_consumed       bigint,
  affiliate_share_cents bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    sol.id                                AS solution_id,
    sol.name                              AS solution_name,
    SUM(ue.quantity)::bigint              AS units_consumed,
    SUM(ue.affiliate_share_cents)::bigint AS affiliate_share_cents
  FROM public.usage_events ue
  JOIN public.subscriptions sub ON sub.id = ue.subscription_id
  JOIN public.solutions sol ON sol.meter_id = ue.meter_id
  WHERE sub.affiliate_id = p_affiliate_id
    AND ue.affiliate_share_cents IS NOT NULL
    AND ue.created_at >= now() - make_interval(days => p_days)
  GROUP BY sol.id, sol.name
$$;

-- ---------------------------------------------------------------------------
-- 9. Updated trigger: reseller_metered_offers updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_reseller_metered_offer_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reseller_metered_offers_updated_at ON public.reseller_metered_offers;
CREATE TRIGGER trg_reseller_metered_offers_updated_at
  BEFORE UPDATE ON public.reseller_metered_offers
  FOR EACH ROW EXECUTE FUNCTION public.set_reseller_metered_offer_updated_at();
