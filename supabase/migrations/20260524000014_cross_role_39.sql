-- =============================================================================
-- #39 — Cross-role: notifications, account settings, onboarding, CSV export,
--        vendor webhooks, partner platform API
-- =============================================================================

-- =============================================================================
-- 1. profiles.onboarding_state — per-role checklist progress
-- =============================================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarding_state jsonb DEFAULT '{}'::jsonb;

-- =============================================================================
-- 2. notifications — in-app notification feed
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.notifications (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type       text        NOT NULL,   -- 'renewal_failed', 'payout_sent', 'app_approved', ...
  title      text        NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notif_user_created_idx ON public.notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notif_user_unread_idx  ON public.notifications (user_id) WHERE read_at IS NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Users read and mark-read their own notifications only
CREATE POLICY notif_own_select ON public.notifications
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY notif_own_update ON public.notifications
  FOR UPDATE USING (user_id = auth.uid());

-- Only service-role may insert (producers are webhook handlers / crons / admin)
CREATE POLICY notif_service_insert ON public.notifications
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- =============================================================================
-- 3. notification_preferences — per-user, per-type toggles
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid    NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notif_type      text    NOT NULL,
  in_app_enabled  boolean NOT NULL DEFAULT true,
  email_enabled   boolean NOT NULL DEFAULT true,
  -- 'immediate' | 'daily' | 'weekly' — for digest types
  frequency       text    NOT NULL DEFAULT 'immediate',
  quiet_start     time,
  quiet_end       time,
  UNIQUE (user_id, notif_type)
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY notif_pref_own ON public.notification_preferences
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- =============================================================================
-- 4. vendor_webhooks — outbound webhook subscriptions (vendor-to-partner)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.vendor_webhooks (
  id               uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        uuid      NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  org_id           uuid      REFERENCES public.organizations(id) ON DELETE CASCADE,
  app_id           uuid      REFERENCES public.apps(id) ON DELETE CASCADE,
  url              text      NOT NULL,
  signing_secret   text      NOT NULL,     -- stored plaintext; shown once to vendor
  events           text[]    NOT NULL,     -- ['v1.subscription.created', ...]
  enabled          boolean   NOT NULL DEFAULT true,
  consecutive_failures int   NOT NULL DEFAULT 0,
  disabled_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vw_vendor_idx ON public.vendor_webhooks (vendor_id);
CREATE INDEX IF NOT EXISTS vw_enabled_idx ON public.vendor_webhooks (vendor_id) WHERE enabled = true;

ALTER TABLE public.vendor_webhooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY vw_vendor_select ON public.vendor_webhooks
  FOR SELECT USING (vendor_id = auth.uid());

CREATE POLICY vw_vendor_insert ON public.vendor_webhooks
  FOR INSERT WITH CHECK (vendor_id = auth.uid());

CREATE POLICY vw_vendor_update ON public.vendor_webhooks
  FOR UPDATE USING (vendor_id = auth.uid());

CREATE POLICY vw_vendor_delete ON public.vendor_webhooks
  FOR DELETE USING (vendor_id = auth.uid());

CREATE POLICY vw_service ON public.vendor_webhooks
  FOR ALL USING (auth.role() = 'service_role');

-- vendor_webhook_deliveries was created as a stub in #48; add missing columns
-- if they don't exist yet (migration is idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'vendor_webhook_deliveries'
      AND column_name  = 'webhook_id'
  ) THEN
    ALTER TABLE public.vendor_webhook_deliveries
      ADD COLUMN webhook_id uuid REFERENCES public.vendor_webhooks(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'vendor_webhook_deliveries'
      AND column_name  = 'attempt'
  ) THEN
    ALTER TABLE public.vendor_webhook_deliveries ADD COLUMN attempt int NOT NULL DEFAULT 1;
  END IF;
END;
$$;

-- =============================================================================
-- 5. api_keys — partner platform API keys (test/live, org-scoped)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.api_keys (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name         text    NOT NULL,
  hashed_key   text    NOT NULL UNIQUE,   -- SHA-256 hex; full key shown once at creation
  prefix       text    NOT NULL,          -- e.g. 'pk_test_ab12' — display only
  mode         text    NOT NULL CHECK (mode IN ('test', 'live')),
  scopes       text[]  NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ak_org_idx  ON public.api_keys (org_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ak_hash_idx ON public.api_keys (hashed_key);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Org admin/owner manage keys; service role for validation lookups
CREATE POLICY ak_org_read ON public.api_keys
  FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM public.org_members
      WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY ak_org_insert ON public.api_keys
  FOR INSERT
  WITH CHECK (
    org_id IN (
      SELECT org_id FROM public.org_members
      WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY ak_org_update ON public.api_keys
  FOR UPDATE
  USING (
    org_id IN (
      SELECT org_id FROM public.org_members
      WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY ak_service ON public.api_keys
  FOR ALL USING (auth.role() = 'service_role');

-- =============================================================================
-- 6. idempotency_keys — replay cache for mutating /api/v1/* requests
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  id              uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid  NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  idempotency_key text  NOT NULL,
  request_hash    text  NOT NULL,   -- SHA-256 of method+path+body
  response_status int   NOT NULL,
  response_body   jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ik_org_key_idx ON public.idempotency_keys (org_id, idempotency_key);
-- Auto-expire after 24h — partition rotation cron handles cleanup
CREATE INDEX IF NOT EXISTS ik_created_idx ON public.idempotency_keys (created_at);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY ik_service ON public.idempotency_keys
  FOR ALL USING (auth.role() = 'service_role');
