-- =============================================================================
-- #37 — Marketplace v2
-- =============================================================================

-- (A) New columns on apps -------------------------------------------------------

ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS rating_avg     numeric(3,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_count   int          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS featured_until timestamptz,
  ADD COLUMN IF NOT EXISTS has_free_trial bool         NOT NULL DEFAULT false;

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS apps_fts_idx
  ON public.apps
  USING gin (to_tsvector('english', name || ' ' || COALESCE(description, '')));

-- Index for featured apps lookup
CREATE INDEX IF NOT EXISTS apps_featured_idx
  ON public.apps (featured_until)
  WHERE featured_until IS NOT NULL;

-- (B) app_reviews ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.app_reviews (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           uuid        NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  buyer_id         uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subscription_id  uuid        NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  rating           smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title            text,
  body             text,
  vendor_response  text,
  status           text        NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_reviews_buyer_app_unique UNIQUE (app_id, buyer_id)
);

CREATE INDEX IF NOT EXISTS app_reviews_app_id_idx   ON public.app_reviews (app_id);
CREATE INDEX IF NOT EXISTS app_reviews_buyer_id_idx ON public.app_reviews (buyer_id);
CREATE INDEX IF NOT EXISTS app_reviews_status_idx   ON public.app_reviews (status, app_id);

CREATE TRIGGER app_reviews_updated_at
  BEFORE UPDATE ON public.app_reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- (C) RLS on app_reviews --------------------------------------------------------

ALTER TABLE public.app_reviews ENABLE ROW LEVEL SECURITY;

-- Anyone reads published reviews
CREATE POLICY "reviews_select_published" ON public.app_reviews
  FOR SELECT
  USING (status = 'published');

-- Buyers see their own review regardless of status
CREATE POLICY "reviews_select_own" ON public.app_reviews
  FOR SELECT
  USING (buyer_id = auth.uid());

-- Admin reads all
CREATE POLICY "reviews_admin_select_all" ON public.app_reviews
  FOR SELECT
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

-- Verified buyers insert their own review
CREATE POLICY "reviews_buyer_insert" ON public.app_reviews
  FOR INSERT TO authenticated
  WITH CHECK (
    buyer_id = auth.uid()
    AND (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'buyer'
  );

-- Vendor org member may update (service layer restricts to vendor_response column)
CREATE POLICY "reviews_vendor_update" ON public.app_reviews
  FOR UPDATE TO authenticated
  USING (
    app_id IN (
      SELECT id FROM public.apps WHERE org_id = ANY(SELECT public.my_org_ids())
    )
  );

-- Admin full update (to moderate status)
CREATE POLICY "reviews_admin_update" ON public.app_reviews
  FOR UPDATE TO authenticated
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

-- Buyer deletes own review
CREATE POLICY "reviews_buyer_delete" ON public.app_reviews
  FOR DELETE TO authenticated
  USING (buyer_id = auth.uid());

-- (D) Trigger to maintain rating_avg / rating_count on apps ---------------------

CREATE OR REPLACE FUNCTION public.refresh_app_rating()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app_id uuid;
BEGIN
  v_app_id := COALESCE(NEW.app_id, OLD.app_id);

  UPDATE public.apps
  SET
    rating_avg   = COALESCE((
      SELECT ROUND(AVG(rating)::numeric, 2)
      FROM   public.app_reviews
      WHERE  app_id = v_app_id AND status = 'published'
    ), 0),
    rating_count = (
      SELECT COUNT(*)
      FROM   public.app_reviews
      WHERE  app_id = v_app_id AND status = 'published'
    )
  WHERE id = v_app_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER app_reviews_rating_refresh
  AFTER INSERT OR UPDATE OR DELETE ON public.app_reviews
  FOR EACH ROW EXECUTE FUNCTION public.refresh_app_rating();

-- (E) Updated list_marketplace_apps RPC -----------------------------------------
-- Adds sort, price/rating/affiliate/trial filters, full-text search, and
-- rating_avg, rating_count, affiliate_commission_bps, has_free_trial,
-- subscriber_count in the result set.
--
-- sort values: 'trending' (default) | 'newest' | 'price_asc' | 'price_desc' | 'rating'
-- trending = subscriber_count weighted by recency (epoch days since created_at)
--
-- ORDER BY encodes each sort key as a zero-padded text string so a single CASE
-- expression can drive ascending vs descending without dynamic SQL.
DROP FUNCTION IF EXISTS public.list_marketplace_apps(text, text, integer, integer);
CREATE OR REPLACE FUNCTION public.list_marketplace_apps(
  p_search        text    DEFAULT NULL,
  p_category      text    DEFAULT NULL,
  p_page          int     DEFAULT 1,
  p_page_size     int     DEFAULT 24,
  p_sort          text    DEFAULT 'trending',
  p_price_min     int     DEFAULT NULL,
  p_price_max     int     DEFAULT NULL,
  p_rating_min    numeric DEFAULT NULL,
  p_has_affiliate bool    DEFAULT NULL,
  p_has_trial     bool    DEFAULT NULL
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
      COALESCE(s.active_subs, 0)                   AS subscriber_count
    FROM   public.apps     a
    JOIN   public.profiles p ON p.id = a.vendor_id
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
        -- trending: score = (active_subs × 10) + days_since_epoch
        LPAD(
          (subscriber_count * 10 + EXTRACT(EPOCH FROM created_at)::bigint / 86400)::text,
          20, '0'
        )
    END DESC NULLS LAST,
    name ASC
  LIMIT  p_page_size
  OFFSET ((p_page - 1) * p_page_size);
$$;

-- (F) Featured apps RPC ----------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_featured_apps(p_limit int DEFAULT 5)
RETURNS TABLE (
  id              uuid,
  name            text,
  description     text,
  category        text,
  price_cents     bigint,
  currency        text,
  vendor_name     text,
  screenshot_urls text[],
  rating_avg      numeric,
  rating_count    int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id,
    a.name,
    a.description,
    a.category,
    a.price_cents,
    a.currency,
    p.display_name   AS vendor_name,
    a.screenshot_urls,
    a.rating_avg,
    a.rating_count
  FROM   public.apps     a
  JOIN   public.profiles p ON p.id = a.vendor_id
  WHERE  a.status          = 'approved'
    AND  p.charges_enabled = true
    AND  a.featured_until  > now()
  ORDER BY a.featured_until DESC
  LIMIT  p_limit;
$$;

-- (G) List reviews RPC -----------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_app_reviews(
  p_app_id    uuid,
  p_page      int DEFAULT 1,
  p_page_size int DEFAULT 10
)
RETURNS TABLE (
  id              uuid,
  buyer_id        uuid,
  display_name    text,
  rating          smallint,
  title           text,
  body            text,
  vendor_response text,
  status          text,
  created_at      timestamptz,
  total_count     bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id,
    r.buyer_id,
    p.display_name,
    r.rating,
    r.title,
    r.body,
    r.vendor_response,
    r.status,
    r.created_at,
    COUNT(*) OVER () AS total_count
  FROM   public.app_reviews r
  JOIN   public.profiles    p ON p.id = r.buyer_id
  WHERE  r.app_id = p_app_id
    AND  r.status = 'published'
  ORDER BY r.created_at DESC
  LIMIT  p_page_size
  OFFSET ((p_page - 1) * p_page_size);
$$;

-- (H) Updated get_marketplace_app RPC to include ratings -------------------------
DROP FUNCTION IF EXISTS public.get_marketplace_app(uuid);
CREATE OR REPLACE FUNCTION public.get_marketplace_app(p_id uuid)
RETURNS TABLE (
  id                       uuid,
  name                     text,
  description              text,
  category                 text,
  price_cents              bigint,
  currency                 text,
  auth_url                 text,
  vendor_name              text,
  screenshot_urls          text[],
  rating_avg               numeric,
  rating_count             int,
  affiliate_commission_bps smallint,
  has_free_trial           bool
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id,
    a.name,
    a.description,
    a.category,
    a.price_cents,
    a.currency,
    a.auth_url,
    p.display_name           AS vendor_name,
    a.screenshot_urls,
    a.rating_avg,
    a.rating_count,
    a.affiliate_commission_bps,
    a.has_free_trial
  FROM   public.apps     a
  JOIN   public.profiles p ON p.id = a.vendor_id
  WHERE  a.id     = p_id
    AND  a.status = 'approved'
    AND  p.charges_enabled = true;
$$;
