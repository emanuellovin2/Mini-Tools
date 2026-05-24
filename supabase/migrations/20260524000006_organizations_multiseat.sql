-- =============================================================
-- Migration #47: Organizations & multi-seat foundation
-- =============================================================
-- One ownership type: org_id. Every user gets a personal org on
-- signup. Existing rows are backfilled to the owner's personal org.
-- RLS switches from (user_id = auth.uid()) to is_org_member().
-- Connect columns are ALSO written to organizations (canonical);
-- profiles copies stay synced for backward compat until #48 cleanup.
-- Follow #48 §5.4 safety pattern throughout.
-- =============================================================

-- =============================================================
-- 1. Core tables
-- =============================================================

CREATE TABLE public.organizations (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text        NOT NULL,
  slug              text        UNIQUE,           -- null for personal orgs
  type              text        NOT NULL CHECK (type IN ('personal', 'team')),
  -- Connect / payout columns (canonical source post-#47)
  stripe_account_id text,
  charges_enabled   bool        NOT NULL DEFAULT false,
  payouts_enabled   bool        NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orgs_stripe_account_idx ON public.organizations (stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;

CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------

CREATE TABLE public.org_members (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.profiles(id)     ON DELETE CASCADE,
  role       text        NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

-- Load-bearing index (§5.3 RLS perf rules): covers is_org_member() lookups
CREATE INDEX org_members_user_org_role_idx
  ON public.org_members (user_id, org_id) INCLUDE (role);

-- ------------------------------------------------------------

CREATE TABLE public.org_invitations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email       text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash  text        NOT NULL UNIQUE,
  invited_by  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX org_invitations_email_idx ON public.org_invitations (email);
CREATE INDEX org_invitations_org_idx   ON public.org_invitations (org_id);

-- =============================================================
-- 2. SQL helpers — STABLE SECURITY DEFINER so Postgres caches
--    within a query (not per-row). Critical for RLS on hot tables.
-- =============================================================

CREATE OR REPLACE FUNCTION public.is_org_member(
  p_org_id  uuid,
  p_min_role text DEFAULT 'member'
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id  = p_org_id
      AND user_id = auth.uid()
      AND CASE p_min_role
            WHEN 'owner' THEN role = 'owner'
            WHEN 'admin' THEN role IN ('owner', 'admin')
            ELSE              true
          END
  );
$$;

-- Returns all org ids the caller belongs to (any role).
-- Prefer `org_id = ANY(SELECT my_org_ids())` over per-row is_org_member
-- on hot tables — the planner inlines this once per query.
CREATE OR REPLACE FUNCTION public.my_org_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_id FROM org_members WHERE user_id = auth.uid();
$$;

-- Returns the personal org id of the caller (for convenience in triggers).
CREATE OR REPLACE FUNCTION public.get_user_personal_org(p_user_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id
  FROM   organizations o
  JOIN   org_members   m ON m.org_id = o.id
  WHERE  m.user_id = p_user_id AND o.type = 'personal'
  LIMIT  1;
$$;

-- =============================================================
-- 3. Add org_id columns (nullable first — backfill next — NOT NULL last)
--    §5.4 migration safety pattern, even pre-launch for muscle memory.
-- =============================================================

ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

ALTER TABLE public.reseller_offers
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

ALTER TABLE public.affiliate_links
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

ALTER TABLE public.reseller_subscriptions
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

ALTER TABLE public.vendor_billing
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

ALTER TABLE public.vendor_revenue_events
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

-- actor_org_id on audit_log: who acted (which org).
-- NULL for system/admin events; populated by writeAuditLog for member actions.
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS actor_org_id uuid REFERENCES public.organizations(id);

CREATE INDEX IF NOT EXISTS audit_log_actor_org_idx
  ON public.audit_log (actor_org_id) WHERE actor_org_id IS NOT NULL;

-- =============================================================
-- 4. BEFORE INSERT triggers: auto-set org_id from ownership cols
--    SECURITY DEFINER so the lookup bypasses RLS on org_members.
--    This means existing code that omits org_id still works.
-- =============================================================

CREATE OR REPLACE FUNCTION public.auto_set_org_id_from_vendor()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.org_id IS NULL AND NEW.vendor_id IS NOT NULL THEN
    NEW.org_id := get_user_personal_org(NEW.vendor_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_set_org_id_from_reseller()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.org_id IS NULL AND NEW.reseller_id IS NOT NULL THEN
    NEW.org_id := get_user_personal_org(NEW.reseller_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_set_org_id_from_affiliate()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.org_id IS NULL AND NEW.affiliate_id IS NOT NULL THEN
    NEW.org_id := get_user_personal_org(NEW.affiliate_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER apps_set_org_id
  BEFORE INSERT ON public.apps
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_org_id_from_vendor();

CREATE TRIGGER reseller_offers_set_org_id
  BEFORE INSERT ON public.reseller_offers
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_org_id_from_reseller();

CREATE TRIGGER affiliate_links_set_org_id
  BEFORE INSERT ON public.affiliate_links
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_org_id_from_affiliate();

CREATE TRIGGER reseller_subscriptions_set_org_id
  BEFORE INSERT ON public.reseller_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_org_id_from_reseller();

CREATE TRIGGER vendor_billing_set_org_id
  BEFORE INSERT ON public.vendor_billing
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_org_id_from_vendor();

CREATE TRIGGER vendor_revenue_events_set_org_id
  BEFORE INSERT ON public.vendor_revenue_events
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_org_id_from_vendor();

-- =============================================================
-- 5. Backfill: create personal org per profile → repoint all rows
-- =============================================================

DO $$
DECLARE
  p       record;
  org_id  uuid;
BEGIN
  FOR p IN
    SELECT id, display_name, stripe_account_id, charges_enabled, payouts_enabled
    FROM   public.profiles
  LOOP
    -- Create personal org (inherits Connect status from profile)
    INSERT INTO public.organizations (name, type, stripe_account_id, charges_enabled, payouts_enabled)
    VALUES (
      COALESCE(p.display_name, 'Personal'),
      'personal',
      p.stripe_account_id,
      p.charges_enabled,
      p.payouts_enabled
    )
    RETURNING id INTO org_id;

    -- Make this user the owner
    INSERT INTO public.org_members (org_id, user_id, role)
    VALUES (org_id, p.id, 'owner');

    -- Repoint owned rows
    UPDATE public.apps                  SET org_id = org_id WHERE vendor_id     = p.id AND apps.org_id IS NULL;
    UPDATE public.reseller_offers       SET org_id = org_id WHERE reseller_id   = p.id AND reseller_offers.org_id IS NULL;
    UPDATE public.affiliate_links       SET org_id = org_id WHERE affiliate_id  = p.id AND affiliate_links.org_id IS NULL;
    UPDATE public.reseller_subscriptions SET org_id = org_id WHERE reseller_id  = p.id AND reseller_subscriptions.org_id IS NULL;
    UPDATE public.vendor_billing        SET org_id = org_id WHERE vendor_id     = p.id AND vendor_billing.org_id IS NULL;
    UPDATE public.vendor_revenue_events SET org_id = org_id WHERE vendor_id     = p.id AND vendor_revenue_events.org_id IS NULL;
  END LOOP;
END;
$$;

-- Add NOT NULL now that backfill is done (safe: pre-launch, no live rows missed)
ALTER TABLE public.apps                   ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.reseller_offers        ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.affiliate_links        ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.reseller_subscriptions ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.vendor_billing         ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.vendor_revenue_events  ALTER COLUMN org_id SET NOT NULL;

-- Performance indexes on new org_id columns
CREATE INDEX IF NOT EXISTS apps_org_id_idx                   ON public.apps                   (org_id);
CREATE INDEX IF NOT EXISTS reseller_offers_org_id_idx        ON public.reseller_offers        (org_id);
CREATE INDEX IF NOT EXISTS affiliate_links_org_id_idx        ON public.affiliate_links        (org_id);
CREATE INDEX IF NOT EXISTS reseller_subscriptions_org_id_idx ON public.reseller_subscriptions (org_id);
CREATE INDEX IF NOT EXISTS vendor_billing_org_id_idx         ON public.vendor_billing         (org_id);
CREATE INDEX IF NOT EXISTS vendor_revenue_events_org_id_idx  ON public.vendor_revenue_events  (org_id);

-- =============================================================
-- 6. Update handle_new_user: also create personal org on signup
-- =============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  intended      text;
  resolved_role public.user_role;
  new_org_id    uuid;
BEGIN
  intended := NEW.raw_user_meta_data->>'intended_role';
  IF    intended = 'vendor'   THEN resolved_role := 'vendor';
  ELSIF intended = 'affiliate' THEN resolved_role := 'affiliate';
  ELSIF intended = 'reseller'  THEN resolved_role := 'reseller';
  ELSE                              resolved_role := 'buyer';
  END IF;

  INSERT INTO public.profiles (id, role) VALUES (NEW.id, resolved_role);

  INSERT INTO public.organizations (name, type)
  VALUES (COALESCE(NEW.raw_user_meta_data->>'full_name', 'Personal'), 'personal')
  RETURNING id INTO new_org_id;

  INSERT INTO public.org_members (org_id, user_id, role)
  VALUES (new_org_id, NEW.id, 'owner');

  RETURN NEW;
END;
$$;

-- =============================================================
-- 7. RLS for new tables
-- =============================================================

ALTER TABLE public.organizations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_invitations ENABLE ROW LEVEL SECURITY;

-- organizations: members can read their own org(s)
CREATE POLICY "orgs_select_member" ON public.organizations FOR SELECT
  USING (id = ANY(SELECT public.my_org_ids()));

-- owners can update org name/slug/branding; NOT Connect columns (service-role only)
CREATE POLICY "orgs_update_owner" ON public.organizations FOR UPDATE
  USING  (public.is_org_member(id, 'owner'))
  WITH CHECK (
    public.is_org_member(id, 'owner')
    AND stripe_account_id IS NOT DISTINCT FROM
        (SELECT o2.stripe_account_id FROM public.organizations o2 WHERE o2.id = id)
    AND charges_enabled =
        (SELECT o2.charges_enabled FROM public.organizations o2 WHERE o2.id = id)
    AND payouts_enabled =
        (SELECT o2.payouts_enabled FROM public.organizations o2 WHERE o2.id = id)
  );

-- admin reads all
CREATE POLICY "orgs_all_admin" ON public.organizations FOR ALL
  USING (public.get_current_user_role() = 'admin');

-- org_members: members read their org's roster
CREATE POLICY "org_members_select_member" ON public.org_members FOR SELECT
  USING (org_id = ANY(SELECT public.my_org_ids()));

-- admins/owners can add members (invite accept writes here)
CREATE POLICY "org_members_insert_admin" ON public.org_members FOR INSERT
  WITH CHECK (public.is_org_member(org_id, 'admin'));

-- owner can remove other members (cannot remove self — checked in service layer)
CREATE POLICY "org_members_delete_owner" ON public.org_members FOR DELETE
  USING (public.is_org_member(org_id, 'owner') AND user_id <> auth.uid());

-- admins can change roles (owner role change restricted to owner in service layer)
CREATE POLICY "org_members_update_admin" ON public.org_members FOR UPDATE
  USING  (public.is_org_member(org_id, 'admin'))
  WITH CHECK (public.is_org_member(org_id, 'admin'));

-- org_invitations: admins manage
CREATE POLICY "invitations_select_admin" ON public.org_invitations FOR SELECT
  USING (public.is_org_member(org_id, 'admin'));
CREATE POLICY "invitations_insert_admin" ON public.org_invitations FOR INSERT
  WITH CHECK (public.is_org_member(org_id, 'admin'));
CREATE POLICY "invitations_delete_admin" ON public.org_invitations FOR DELETE
  USING (public.is_org_member(org_id, 'admin'));
-- Anyone can read an invite they were sent (token accept flow — match by email)
CREATE POLICY "invitations_select_token" ON public.org_invitations FOR SELECT
  USING (email = (SELECT email FROM auth.users WHERE id = auth.uid()));

-- =============================================================
-- 8. Update ownership RLS policies on existing tables
--    Drop user_id = auth.uid() patterns; replace with org membership.
-- =============================================================

-- ---- apps ----
DROP POLICY IF EXISTS "apps_select_own"  ON public.apps;
DROP POLICY IF EXISTS "apps_insert_own"  ON public.apps;
DROP POLICY IF EXISTS "apps_update_own"  ON public.apps;
DROP POLICY IF EXISTS "apps_select_public" ON public.apps;

CREATE POLICY "apps_select_org" ON public.apps FOR SELECT
  USING (org_id = ANY(SELECT public.my_org_ids()));

CREATE POLICY "apps_insert_org" ON public.apps FOR INSERT
  WITH CHECK (
    org_id = ANY(SELECT public.my_org_ids())
    AND public.is_org_member(org_id, 'admin')
    AND public.get_current_user_role() = 'vendor'
  );

CREATE POLICY "apps_update_org" ON public.apps FOR UPDATE
  USING  (org_id = ANY(SELECT public.my_org_ids()) AND public.is_org_member(org_id, 'admin'))
  WITH CHECK (org_id = ANY(SELECT public.my_org_ids()) AND public.is_org_member(org_id, 'admin'));

-- Public browsing: approved apps from orgs with charges enabled
CREATE POLICY "apps_select_public" ON public.apps FOR SELECT
  USING (
    status = 'approved'
    AND EXISTS (
      SELECT 1 FROM public.organizations o
      WHERE o.id = org_id AND o.charges_enabled = true
    )
  );

-- ---- affiliate_links ----
DROP POLICY IF EXISTS "affiliate_links_select_own" ON public.affiliate_links;
DROP POLICY IF EXISTS "affiliate_links_insert_own" ON public.affiliate_links;

CREATE POLICY "affiliate_links_select_org" ON public.affiliate_links FOR SELECT
  USING (org_id = ANY(SELECT public.my_org_ids()));

CREATE POLICY "affiliate_links_insert_org" ON public.affiliate_links FOR INSERT
  WITH CHECK (
    org_id = ANY(SELECT public.my_org_ids())
    AND public.get_current_user_role() = 'affiliate'
  );

-- ---- reseller_offers ----
DROP POLICY IF EXISTS "reseller_offers_all_own"       ON public.reseller_offers;
DROP POLICY IF EXISTS "reseller_offers_select_vendor" ON public.reseller_offers;

CREATE POLICY "reseller_offers_all_org" ON public.reseller_offers FOR ALL
  USING (
    org_id = ANY(SELECT public.my_org_ids())
    AND public.get_current_user_role() = 'reseller'
  )
  WITH CHECK (
    org_id = ANY(SELECT public.my_org_ids())
    AND public.get_current_user_role() = 'reseller'
  );

-- Vendors can see reseller offers for their apps (anti-poaching-safe view)
CREATE POLICY "reseller_offers_select_vendor" ON public.reseller_offers FOR SELECT
  USING (
    app_id IN (
      SELECT id FROM public.apps
      WHERE org_id = ANY(SELECT public.my_org_ids())
    )
  );

-- ---- vendor_billing ----
DROP POLICY IF EXISTS "vendor_billing_select_own" ON public.vendor_billing;

CREATE POLICY "vendor_billing_select_org" ON public.vendor_billing FOR SELECT
  USING (org_id = ANY(SELECT public.my_org_ids()));

-- ---- vendor_revenue_events ----
DROP POLICY IF EXISTS "vendor_revenue_events_select_own" ON public.vendor_revenue_events;

CREATE POLICY "vendor_revenue_events_select_org" ON public.vendor_revenue_events FOR SELECT
  USING (org_id = ANY(SELECT public.my_org_ids()));

-- ---- reseller_subscriptions ----
DROP POLICY IF EXISTS "reseller_subscriptions_select_own" ON public.reseller_subscriptions;

CREATE POLICY "reseller_subscriptions_select_org" ON public.reseller_subscriptions FOR SELECT
  USING (org_id = ANY(SELECT public.my_org_ids()));

-- ---- audit_log: org admins see their own org's activity ----
CREATE POLICY "audit_log_select_org_admin" ON public.audit_log FOR SELECT
  USING (
    actor_org_id IS NOT NULL
    AND public.is_org_member(actor_org_id, 'admin')
  );
