-- ============================================================
-- Migration #3: Core schema, RLS, and anti-poaching boundary
-- (affiliate enum value added in migration #2)
-- ============================================================

-- 1. Add new columns to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS slug               text UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_account_id  text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS charges_enabled    bool NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payouts_enabled    bool NOT NULL DEFAULT false;

-- 3. Helper: resolve calling user's role without triggering RLS recursion
--    SECURITY DEFINER means it runs as its owner (postgres/service role),
--    bypassing RLS on the profiles table.
CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS public.user_role
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

-- 4. Replace profiles UPDATE policy: now also guards stripe / connect columns
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    -- role is immutable via the client
    AND role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid())
    -- stripe / connect columns are service-role-only
    AND (stripe_account_id IS NOT DISTINCT FROM
           (SELECT p.stripe_account_id FROM public.profiles p WHERE p.id = auth.uid()))
    AND (stripe_customer_id IS NOT DISTINCT FROM
           (SELECT p.stripe_customer_id FROM public.profiles p WHERE p.id = auth.uid()))
    AND charges_enabled =
           (SELECT p.charges_enabled FROM public.profiles p WHERE p.id = auth.uid())
    AND payouts_enabled =
           (SELECT p.payouts_enabled FROM public.profiles p WHERE p.id = auth.uid())
  );

-- Admin can read all profiles (vendor sees only their own via existing policy)
CREATE POLICY "profiles_select_admin" ON public.profiles FOR SELECT
  USING (public.get_current_user_role() = 'admin');

-- ============================================================
-- New enums
-- ============================================================

CREATE TYPE public.app_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TYPE public.subscription_status AS ENUM (
  'incomplete',
  'incomplete_expired',
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'canceled',
  'paused'
);

CREATE TYPE public.reseller_offer_status AS ENUM ('draft', 'active', 'paused');

-- ============================================================
-- apps
-- ============================================================

CREATE TABLE public.apps (
  id                uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id         uuid             NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  name              text             NOT NULL,
  description       text,
  category          text,
  price_cents       bigint           NOT NULL CHECK (price_cents >= 0),
  min_price_cents   bigint           CHECK (min_price_cents >= 0),
  currency          text             NOT NULL DEFAULT 'usd',
  auth_url          text,
  logo_url          text,
  status            public.app_status NOT NULL DEFAULT 'pending',
  stripe_product_id text,
  stripe_price_id   text,
  created_at        timestamptz      NOT NULL DEFAULT now(),
  updated_at        timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT apps_min_price_check
    CHECK (min_price_cents IS NULL OR min_price_cents <= price_cents)
);

CREATE INDEX apps_status_idx   ON public.apps (status);
CREATE INDEX apps_vendor_idx   ON public.apps (vendor_id);
CREATE INDEX apps_category_idx ON public.apps (category);
CREATE INDEX apps_min_price_idx
  ON public.apps (min_price_cents) WHERE min_price_cents IS NOT NULL;

CREATE TRIGGER apps_updated_at
  BEFORE UPDATE ON public.apps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- subscriptions (reseller_offer FK added after reseller_offers table)
-- ============================================================

CREATE TABLE public.subscriptions (
  id                          uuid                       PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id                    uuid                       NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  app_id                      uuid                       NOT NULL REFERENCES public.apps(id)     ON DELETE RESTRICT,
  stripe_subscription_id      text                       NOT NULL UNIQUE,
  stripe_customer_id          text                       NOT NULL,
  status                      public.subscription_status NOT NULL,
  price_cents                 bigint                     NOT NULL CHECK (price_cents >= 0),
  currency                    text                       NOT NULL DEFAULT 'usd',
  -- Opaque stable id per (buyer_id, app_id) across resubscriptions; intentionally NOT UNIQUE
  anon_user_id                text                       NOT NULL,
  cancel_at_period_end        bool                       NOT NULL DEFAULT false,
  current_period_end          timestamptz                NOT NULL,
  canceled_at                 timestamptz,
  -- Phase-2 attribution; at most one of (affiliate_id, reseller_id) may be set
  affiliate_id                uuid                       REFERENCES public.profiles(id),
  reseller_id                 uuid                       REFERENCES public.profiles(id),
  reseller_offer_id           uuid,
  vendor_floor_snapshot_cents bigint                     CHECK (vendor_floor_snapshot_cents >= 0),
  created_at                  timestamptz                NOT NULL DEFAULT now(),
  updated_at                  timestamptz                NOT NULL DEFAULT now(),
  -- Mutually exclusive attribution
  CONSTRAINT sub_mutual_excl
    CHECK (NOT (affiliate_id IS NOT NULL AND reseller_id IS NOT NULL)),
  -- reseller_offer_id is non-null iff reseller_id is non-null
  CONSTRAINT sub_reseller_offer_null
    CHECK ((reseller_id IS NULL) = (reseller_offer_id IS NULL)),
  -- vendor floor is non-null iff reseller_id is non-null
  CONSTRAINT sub_floor_null
    CHECK ((reseller_id IS NULL) = (vendor_floor_snapshot_cents IS NULL))
);

-- No double-active subscription per buyer+app
CREATE UNIQUE INDEX subscriptions_active_unique
  ON public.subscriptions (buyer_id, app_id)
  WHERE status IN (
    'incomplete'::public.subscription_status,
    'active'::public.subscription_status,
    'trialing'::public.subscription_status,
    'past_due'::public.subscription_status
  );

CREATE INDEX subscriptions_buyer_idx     ON public.subscriptions (buyer_id);
CREATE INDEX subscriptions_app_idx       ON public.subscriptions (app_id);
CREATE INDEX subscriptions_status_idx    ON public.subscriptions (status);
CREATE INDEX subscriptions_anon_user_idx ON public.subscriptions (anon_user_id);
CREATE INDEX subscriptions_buyer_app_idx ON public.subscriptions (buyer_id, app_id);
CREATE INDEX subscriptions_affiliate_idx
  ON public.subscriptions (affiliate_id) WHERE affiliate_id IS NOT NULL;
CREATE INDEX subscriptions_reseller_idx
  ON public.subscriptions (reseller_id)  WHERE reseller_id  IS NOT NULL;

CREATE TRIGGER subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- vendor_billing
-- ============================================================

CREATE TABLE public.vendor_billing (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  period_start        date        NOT NULL,
  period_end          date        NOT NULL,
  -- Direct + affiliate gross only; reseller-sold excluded (SPEC §3)
  gross_revenue_cents bigint      NOT NULL CHECK (gross_revenue_cents >= 0),
  tier                smallint    NOT NULL CHECK (tier IN (1, 2, 3)),
  cut_bps             int         NOT NULL CHECK (cut_bps >= 0),
  computed_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_billing_period_unique UNIQUE (vendor_id, period_start)
);

CREATE INDEX vendor_billing_vendor_idx ON public.vendor_billing (vendor_id);
CREATE INDEX vendor_billing_period_idx ON public.vendor_billing (period_start);

CREATE TRIGGER vendor_billing_updated_at
  BEFORE UPDATE ON public.vendor_billing
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- webhook_events (PK = Stripe event id for idempotency)
-- ============================================================

CREATE TABLE public.webhook_events (
  id           text        PRIMARY KEY,
  type         text        NOT NULL,
  payload      jsonb       NOT NULL,
  status       text        NOT NULL DEFAULT 'received'
                           CHECK (status IN ('received', 'processed', 'failed')),
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error        text
);

CREATE INDEX webhook_events_status_idx ON public.webhook_events (status);
CREATE INDEX webhook_events_type_idx   ON public.webhook_events (type);

-- ============================================================
-- audit_log (append-only; no updated_at)
-- ============================================================

CREATE TABLE public.audit_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid,
  actor_role  text,
  action      text        NOT NULL,
  entity_type text        NOT NULL,
  entity_id   text,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_actor_idx   ON public.audit_log (actor_id)            WHERE actor_id IS NOT NULL;
CREATE INDEX audit_log_entity_idx  ON public.audit_log (entity_type, entity_id);
CREATE INDEX audit_log_created_idx ON public.audit_log (created_at);

-- ============================================================
-- Phase-2: affiliate_links
-- ============================================================

CREATE TABLE public.affiliate_links (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  code         text        NOT NULL UNIQUE,
  app_id       uuid        REFERENCES public.apps(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX affiliate_links_affiliate_idx ON public.affiliate_links (affiliate_id);
CREATE INDEX affiliate_links_code_idx      ON public.affiliate_links (code);
CREATE INDEX affiliate_links_app_idx
  ON public.affiliate_links (app_id) WHERE app_id IS NOT NULL;

-- ============================================================
-- Phase-2: reseller_offers
-- ============================================================

CREATE TABLE public.reseller_offers (
  id                          uuid                        PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id                 uuid                        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  app_id                      uuid                        NOT NULL REFERENCES public.apps(id)     ON DELETE RESTRICT,
  slug                        text                        NOT NULL,
  sell_price_cents            bigint                      NOT NULL CHECK (sell_price_cents >= 0),
  vendor_floor_snapshot_cents bigint                      NOT NULL CHECK (vendor_floor_snapshot_cents >= 0),
  stripe_price_id             text,
  status                      public.reseller_offer_status NOT NULL DEFAULT 'draft',
  created_at                  timestamptz                 NOT NULL DEFAULT now(),
  updated_at                  timestamptz                 NOT NULL DEFAULT now(),
  CONSTRAINT reseller_offers_slug_unique  UNIQUE (reseller_id, slug),
  CONSTRAINT reseller_offers_app_unique   UNIQUE (reseller_id, app_id),
  CONSTRAINT reseller_offers_price_check
    CHECK (sell_price_cents >= vendor_floor_snapshot_cents)
);

CREATE INDEX reseller_offers_reseller_idx ON public.reseller_offers (reseller_id);
CREATE INDEX reseller_offers_app_idx      ON public.reseller_offers (app_id);
CREATE INDEX reseller_offers_status_idx   ON public.reseller_offers (status);

CREATE TRIGGER reseller_offers_updated_at
  BEFORE UPDATE ON public.reseller_offers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Trigger: capture vendor floor snapshot from apps.min_price_cents on insert;
--          validate app is resellable and sell_price_cents is above the floor.
CREATE OR REPLACE FUNCTION public.validate_reseller_offer_price()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  app_min_price bigint;
BEGIN
  SELECT min_price_cents INTO app_min_price
  FROM public.apps WHERE id = NEW.app_id;

  IF app_min_price IS NULL THEN
    RAISE EXCEPTION 'App % is not resellable (min_price_cents is NULL)', NEW.app_id;
  END IF;

  IF NEW.sell_price_cents < app_min_price THEN
    RAISE EXCEPTION 'sell_price_cents (%) must be >= app min_price_cents (%)',
      NEW.sell_price_cents, app_min_price;
  END IF;

  NEW.vendor_floor_snapshot_cents := app_min_price;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reseller_offer_validate_price
  BEFORE INSERT ON public.reseller_offers
  FOR EACH ROW EXECUTE FUNCTION public.validate_reseller_offer_price();

-- ============================================================
-- Phase-2: reseller_subscriptions ($19/mo platform subscription)
-- ============================================================

CREATE TABLE public.reseller_subscriptions (
  id                     uuid                       PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id            uuid                       NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE RESTRICT,
  stripe_subscription_id text                       NOT NULL UNIQUE,
  status                 public.subscription_status NOT NULL,
  current_period_end     timestamptz                NOT NULL,
  cancel_at_period_end   bool                       NOT NULL DEFAULT false,
  canceled_at            timestamptz,
  created_at             timestamptz                NOT NULL DEFAULT now(),
  updated_at             timestamptz                NOT NULL DEFAULT now()
);

CREATE TRIGGER reseller_subscriptions_updated_at
  BEFORE UPDATE ON public.reseller_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- Phase-2: affiliate_attributions (written once at subscribe time)
-- ============================================================

CREATE TABLE public.affiliate_attributions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid        NOT NULL UNIQUE REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  affiliate_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  code            text        NOT NULL,
  attributed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX affiliate_attributions_affiliate_idx
  ON public.affiliate_attributions (affiliate_id);

-- ============================================================
-- Late FK: subscriptions.reseller_offer_id → reseller_offers
-- ============================================================

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_reseller_offer_fk
  FOREIGN KEY (reseller_offer_id) REFERENCES public.reseller_offers(id);

-- ============================================================
-- RLS
-- ============================================================

-- apps --
ALTER TABLE public.apps ENABLE ROW LEVEL SECURITY;

-- Vendor reads/writes their own apps
CREATE POLICY "apps_select_own"  ON public.apps FOR SELECT
  USING (vendor_id = auth.uid());

CREATE POLICY "apps_insert_own"  ON public.apps FOR INSERT
  WITH CHECK (
    vendor_id = auth.uid()
    AND public.get_current_user_role() = 'vendor'
  );

CREATE POLICY "apps_update_own"  ON public.apps FOR UPDATE
  USING  (vendor_id = auth.uid())
  WITH CHECK (vendor_id = auth.uid());

-- Public sees approved apps from vendors that can receive funds
CREATE POLICY "apps_select_public" ON public.apps FOR SELECT
  USING (
    status = 'approved'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = vendor_id AND p.charges_enabled = true
    )
  );

-- Admin full access
CREATE POLICY "apps_all_admin" ON public.apps FOR ALL
  USING (public.get_current_user_role() = 'admin');

-- subscriptions --
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Buyers can only see their own subscriptions (never another buyer's)
CREATE POLICY "subscriptions_select_buyer" ON public.subscriptions FOR SELECT
  USING (buyer_id = auth.uid());

-- Vendors have NO direct read on subscriptions (anti-poaching; use vendor_subscription_stats())
-- Admin full access
CREATE POLICY "subscriptions_select_admin" ON public.subscriptions FOR SELECT
  USING (public.get_current_user_role() = 'admin');

-- vendor_billing --
ALTER TABLE public.vendor_billing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vendor_billing_select_own" ON public.vendor_billing FOR SELECT
  USING (vendor_id = auth.uid());

CREATE POLICY "vendor_billing_select_admin" ON public.vendor_billing FOR SELECT
  USING (public.get_current_user_role() = 'admin');

-- webhook_events (service role writes; admin reads) --
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook_events_select_admin" ON public.webhook_events FOR SELECT
  USING (public.get_current_user_role() = 'admin');

-- audit_log (append-only: no INSERT/UPDATE/DELETE policies for non-service-role) --
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_log_select_admin" ON public.audit_log FOR SELECT
  USING (public.get_current_user_role() = 'admin');

-- affiliate_links --
ALTER TABLE public.affiliate_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "affiliate_links_select_own" ON public.affiliate_links FOR SELECT
  USING (affiliate_id = auth.uid());

CREATE POLICY "affiliate_links_insert_own" ON public.affiliate_links FOR INSERT
  WITH CHECK (
    affiliate_id = auth.uid()
    AND public.get_current_user_role() = 'affiliate'
  );

-- affiliate_attributions --
ALTER TABLE public.affiliate_attributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "affiliate_attributions_select_own"
  ON public.affiliate_attributions FOR SELECT
  USING (affiliate_id = auth.uid());
-- No INSERT policy: service role writes only

-- reseller_offers --
ALTER TABLE public.reseller_offers ENABLE ROW LEVEL SECURITY;

-- Reseller full CRUD on their own offers
CREATE POLICY "reseller_offers_all_own" ON public.reseller_offers FOR ALL
  USING  (reseller_id = auth.uid())
  WITH CHECK (reseller_id = auth.uid());

-- Buyers see active offers (for storefront browsing)
CREATE POLICY "reseller_offers_select_active" ON public.reseller_offers FOR SELECT
  USING (status = 'active');

-- Vendors see offers referencing their apps (read-only, for awareness)
CREATE POLICY "reseller_offers_select_vendor" ON public.reseller_offers FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.apps a
      WHERE a.id = app_id AND a.vendor_id = auth.uid()
    )
  );

-- Admin full access
CREATE POLICY "reseller_offers_all_admin" ON public.reseller_offers FOR ALL
  USING (public.get_current_user_role() = 'admin');

-- reseller_subscriptions --
ALTER TABLE public.reseller_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reseller_subscriptions_select_own"
  ON public.reseller_subscriptions FOR SELECT
  USING (reseller_id = auth.uid());

CREATE POLICY "reseller_subscriptions_select_admin"
  ON public.reseller_subscriptions FOR SELECT
  USING (public.get_current_user_role() = 'admin');

-- ============================================================
-- Anti-poaching boundary (SECURITY DEFINER functions)
-- These run as the function owner (postgres), bypassing RLS on
-- subscriptions, while still filtering via auth.uid().
-- ============================================================

-- Vendor stats: app_id, anon_user_id, status, price, period end.
-- Never exposes buyer_id or any field joinable to buyer identity.
CREATE OR REPLACE FUNCTION public.vendor_subscription_stats()
RETURNS TABLE (
  app_id             uuid,
  anon_user_id       text,
  status             public.subscription_status,
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
    s.status,
    s.price_cents,
    s.current_period_end
  FROM subscriptions s
  INNER JOIN apps a ON a.id = s.app_id
  WHERE a.vendor_id = auth.uid();
$$;

-- Reseller stats: sale data for the reseller's offers. Never exposes buyer_id.
CREATE OR REPLACE FUNCTION public.reseller_sale_stats()
RETURNS TABLE (
  app_id                      uuid,
  reseller_offer_id           uuid,
  anon_user_id                text,
  status                      public.subscription_status,
  price_cents                 bigint,
  vendor_floor_snapshot_cents bigint,
  current_period_end          timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    s.app_id,
    s.reseller_offer_id,
    s.anon_user_id,
    s.status,
    s.price_cents,
    s.vendor_floor_snapshot_cents,
    s.current_period_end
  FROM subscriptions s
  WHERE s.reseller_id = auth.uid();
$$;

-- Affiliate stats: aggregate counts and MRR only. Never per-buyer rows.
CREATE OR REPLACE FUNCTION public.affiliate_stats()
RETURNS TABLE (
  app_id          uuid,
  active_subs     bigint,
  mrr_gross_cents bigint
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    s.app_id,
    COUNT(*)       FILTER (WHERE s.status = 'active') AS active_subs,
    SUM(s.price_cents) FILTER (WHERE s.status = 'active') AS mrr_gross_cents
  FROM subscriptions s
  WHERE s.affiliate_id = auth.uid()
  GROUP BY s.app_id;
$$;
