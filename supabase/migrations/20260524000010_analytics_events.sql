-- =============================================================
-- Migration #46: Engagement & analytics event capture
-- =============================================================
-- analytics_events: append-only, partitioned monthly, 90d raw retention.
-- analytics_daily: rollup summary (kept indefinitely — drives dashboards).
-- Visitor hash: salted daily-rotating — no raw IP, no PII, DNT respected.
-- =============================================================

-- =============================================================
-- 1. Event type domain
-- =============================================================

-- Text with CHECK for extensibility (no ALTER TYPE needed to add events).
-- Allowed values mirror what proxy.ts + API route + server captures emit.

-- =============================================================
-- 2. analytics_events (raw, append-only, partitioned)
-- =============================================================

CREATE TABLE public.analytics_events (
  id            bigint      GENERATED ALWAYS AS IDENTITY,
  event_type    text        NOT NULL
                            CHECK (event_type IN (
                              'impression','view','click','signup',
                              'checkout_start','checkout_complete',
                              'launch','storefront_visit','marketplace_view'
                            )),
  entity_type   text        NOT NULL
                            CHECK (entity_type IN (
                              'app','offer','affiliate_link','storefront',
                              'agent','workflow','marketplace'
                            )),
  entity_id     text        NOT NULL,
  owner_org_id  uuid        REFERENCES public.organizations(id) ON DELETE SET NULL,
  affiliate_id  uuid        REFERENCES public.profiles(id)     ON DELETE SET NULL,
  reseller_id   uuid        REFERENCES public.profiles(id)     ON DELETE SET NULL,
  visitor_hash  text,       -- null when DNT/GPC; salted daily-rotating
  session_id    text,       -- opaque cookie, no PII
  referrer      text,
  utm           jsonb,
  country       text,       -- 2-letter coarse geo (never city/postal)
  created_at    timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Indexes on parent propagate to partitions
CREATE INDEX ae_entity_idx      ON public.analytics_events (entity_type, entity_id, created_at);
CREATE INDEX ae_affiliate_idx   ON public.analytics_events (affiliate_id, created_at)
  WHERE affiliate_id IS NOT NULL;
CREATE INDEX ae_reseller_idx    ON public.analytics_events (reseller_id, created_at)
  WHERE reseller_id IS NOT NULL;
CREATE INDEX ae_org_idx         ON public.analytics_events (owner_org_id, created_at)
  WHERE owner_org_id IS NOT NULL;

-- Seed partitions: current month + next 2
CREATE TABLE public.analytics_events_2026_05 PARTITION OF public.analytics_events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE public.analytics_events_2026_06 PARTITION OF public.analytics_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE public.analytics_events_2026_07 PARTITION OF public.analytics_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- RLS: append-only write open (service role + API route bypass RLS).
-- Read: owner org sees its entities; affiliates/resellers see their channel only.
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY ae_owner_org_read ON public.analytics_events
  FOR SELECT
  USING (
    owner_org_id IS NOT NULL
    AND owner_org_id = ANY(SELECT public.my_org_ids())
  );

-- Admin full read
CREATE POLICY ae_admin_read ON public.analytics_events
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  ));

-- =============================================================
-- 3. analytics_daily (rollup — kept indefinitely)
-- =============================================================
-- One row per (date, entity_type, entity_id, owner_org_id,
--              affiliate_id, reseller_id, event_type).
-- Rollup cron uses INSERT ... ON CONFLICT DO UPDATE (idempotent).

CREATE TABLE public.analytics_daily (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date            date        NOT NULL,
  event_type      text        NOT NULL,
  entity_type     text        NOT NULL,
  entity_id       text        NOT NULL,
  owner_org_id    uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  affiliate_id    uuid        REFERENCES public.profiles(id)     ON DELETE SET NULL,
  reseller_id     uuid        REFERENCES public.profiles(id)     ON DELETE SET NULL,
  event_count     bigint      NOT NULL DEFAULT 0,
  unique_visitors bigint      NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Unique key drives ON CONFLICT upsert in rollup cron
CREATE UNIQUE INDEX ad_upsert_key ON public.analytics_daily (
  date, event_type, entity_type, entity_id,
  COALESCE(owner_org_id,  '00000000-0000-0000-0000-000000000000'),
  COALESCE(affiliate_id,  '00000000-0000-0000-0000-000000000000'),
  COALESCE(reseller_id,   '00000000-0000-0000-0000-000000000000')
);

CREATE INDEX ad_entity_idx     ON public.analytics_daily (entity_type, entity_id, date);
CREATE INDEX ad_org_idx        ON public.analytics_daily (owner_org_id, date)
  WHERE owner_org_id IS NOT NULL;
CREATE INDEX ad_affiliate_idx  ON public.analytics_daily (affiliate_id, date)
  WHERE affiliate_id IS NOT NULL;
CREATE INDEX ad_reseller_idx   ON public.analytics_daily (reseller_id, date)
  WHERE reseller_id IS NOT NULL;

CREATE TRIGGER analytics_daily_updated_at
  BEFORE UPDATE ON public.analytics_daily
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.analytics_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY ad_owner_org_read ON public.analytics_daily
  FOR SELECT
  USING (
    owner_org_id IS NOT NULL
    AND owner_org_id = ANY(SELECT public.my_org_ids())
  );

CREATE POLICY ad_admin_read ON public.analytics_daily
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  ));

-- =============================================================
-- 4. Update create_next_month_partitions to include analytics_events
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_next_month_partitions(
  p_month_start date
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start  text := to_char(p_month_start, 'YYYY-MM-DD');
  v_end    text := to_char(p_month_start + interval '1 month', 'YYYY-MM-DD');
  v_suffix text := to_char(p_month_start, 'YYYY_MM');
  v_table  text;
  tables   text[] := ARRAY[
    'audit_log',
    'jobs',
    'vendor_webhook_deliveries',
    'analytics_events'
    -- future: 'usage_events','credit_transactions','run_steps','notifications'
  ];
BEGIN
  FOREACH v_table IN ARRAY tables LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
      v_table || '_' || v_suffix, v_table, v_start, v_end
    );
  END LOOP;
END;
$$;

-- =============================================================
-- 5. Rollup helper RPC (called by analytics-rollup-cron)
-- =============================================================
-- Aggregates raw analytics_events for a given UTC date into analytics_daily.
-- Safe to call multiple times (idempotent via ON CONFLICT DO UPDATE).

CREATE OR REPLACE FUNCTION public.rollup_analytics_day(
  p_date date
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.analytics_daily (
    date, event_type, entity_type, entity_id,
    owner_org_id, affiliate_id, reseller_id,
    event_count, unique_visitors
  )
  SELECT
    p_date                    AS date,
    event_type,
    entity_type,
    entity_id,
    owner_org_id,
    affiliate_id,
    reseller_id,
    COUNT(*)                  AS event_count,
    COUNT(DISTINCT visitor_hash) FILTER (WHERE visitor_hash IS NOT NULL) AS unique_visitors
  FROM public.analytics_events
  WHERE created_at >= p_date::timestamptz
    AND created_at <  (p_date + 1)::timestamptz
  GROUP BY
    event_type, entity_type, entity_id,
    owner_org_id, affiliate_id, reseller_id
  ON CONFLICT (
    date, event_type, entity_type, entity_id,
    COALESCE(owner_org_id,  '00000000-0000-0000-0000-000000000000'),
    COALESCE(affiliate_id,  '00000000-0000-0000-0000-000000000000'),
    COALESCE(reseller_id,   '00000000-0000-0000-0000-000000000000')
  ) DO UPDATE SET
    event_count     = EXCLUDED.event_count,
    unique_visitors = EXCLUDED.unique_visitors,
    updated_at      = now();
END;
$$;
