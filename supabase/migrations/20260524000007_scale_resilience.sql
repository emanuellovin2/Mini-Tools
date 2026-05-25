-- =============================================================
-- Migration #48: Scale & resilience foundation
-- =============================================================
-- Partition policy: PARTITION BY RANGE (created_at) monthly.
-- Retention windows are documented in ENGINEERING.md §6.
-- Safety pattern (§5.4): nullable add → batch backfill → NOT NULL.
-- This migration is pre-launch / clean-break safe.
-- =============================================================

-- =============================================================
-- 1. Recreate audit_log as partitioned table
-- =============================================================
-- audit_log existed as a plain heap table (#2/#47). We recreate
-- it partitioned now, pre-launch, with actor_org_id added (#47).
-- =============================================================

DROP TABLE IF EXISTS public.audit_log CASCADE;

CREATE TABLE public.audit_log (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  actor_id     uuid,
  actor_role   text,
  actor_org_id uuid        REFERENCES public.organizations(id),
  action       text        NOT NULL,
  entity_type  text        NOT NULL,
  entity_id    text,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Indexes on the parent propagate to all partitions
CREATE INDEX audit_log_actor_idx    ON public.audit_log (actor_id)              WHERE actor_id IS NOT NULL;
CREATE INDEX audit_log_org_idx      ON public.audit_log (actor_org_id)          WHERE actor_org_id IS NOT NULL;
CREATE INDEX audit_log_entity_idx   ON public.audit_log (entity_type, entity_id);
CREATE INDEX audit_log_created_idx  ON public.audit_log (created_at);

-- Seed partitions: current month + next 2
CREATE TABLE public.audit_log_2026_05 PARTITION OF public.audit_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE public.audit_log_2026_06 PARTITION OF public.audit_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE public.audit_log_2026_07 PARTITION OF public.audit_log
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Re-apply RLS (was removed by DROP TABLE CASCADE)
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_admin_read ON public.audit_log
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  ));

-- No INSERT policy — service role writes directly (bypasses RLS)
-- No UPDATE / DELETE policies — audit_log is append-only and immutable

-- =============================================================
-- 2. Durable async job queue
-- =============================================================
-- Partition by created_at monthly. Retention: succeeded 14d,
-- failed/dead 90d (archived by partition-rotation-cron).
-- Claim pattern: UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED).
-- =============================================================

CREATE TABLE public.jobs (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  type             text        NOT NULL,  -- 'erasure'|'export'|'rollup'|'settlement'|'webhook_delivery'|...
  payload          jsonb       NOT NULL,
  status           text        NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued','running','succeeded','failed','dead')),
  attempts         int         NOT NULL DEFAULT 0,
  max_attempts     int         NOT NULL DEFAULT 5,
  next_run_at      timestamptz NOT NULL DEFAULT now(),
  locked_by        text,                  -- worker id for atomic claim
  locked_until     timestamptz,           -- lease; stale workers release on expiry
  last_error       text,
  result           jsonb,
  org_id           uuid        REFERENCES public.organizations(id),
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Unique idempotency key per type+month (partition key required in unique index)
CREATE UNIQUE INDEX jobs_idempotency_idx ON public.jobs (type, idempotency_key, created_at)
  WHERE idempotency_key IS NOT NULL;

-- Hot path: worker poll
CREATE INDEX jobs_poll_idx ON public.jobs (status, next_run_at)
  WHERE status IN ('queued', 'running');

-- Admin DLQ view
CREATE INDEX jobs_org_status_idx ON public.jobs (org_id, status)
  WHERE org_id IS NOT NULL;

-- Seed partitions
CREATE TABLE public.jobs_2026_05 PARTITION OF public.jobs
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE public.jobs_2026_06 PARTITION OF public.jobs
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE public.jobs_2026_07 PARTITION OF public.jobs
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- RLS: org members can read their org's jobs; service role writes
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY jobs_org_read ON public.jobs
  FOR SELECT
  USING (
    org_id IS NULL
    OR org_id = ANY(SELECT public.my_org_ids())
  );

-- =============================================================
-- 3. Per-org quotas
-- =============================================================
-- Default-deny for new resource types: every creatable resource
-- MUST have a quota column here + enforceQuota() call.
-- =============================================================

CREATE TABLE public.org_quotas (
  org_id                 uuid  PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- count caps
  max_offers             int   NOT NULL DEFAULT 1000,
  max_api_keys           int   NOT NULL DEFAULT 50,
  max_workflows          int   NOT NULL DEFAULT 500,
  max_affiliate_links    int   NOT NULL DEFAULT 10000,
  max_connectors         int   NOT NULL DEFAULT 100,
  max_webhook_endpoints  int   NOT NULL DEFAULT 25,
  -- rate caps (req/sec; enforced via Upstash + checkRateLimit)
  api_rps                int   NOT NULL DEFAULT 50,
  events_rps             int   NOT NULL DEFAULT 200,
  workflow_runs_rps      int   NOT NULL DEFAULT 20,
  -- size caps
  max_workflow_steps     int   NOT NULL DEFAULT 50,
  max_partner_clients    int   NOT NULL DEFAULT 100000,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Backfill quotas for all existing orgs (one row each, all defaults)
INSERT INTO public.org_quotas (org_id)
SELECT id FROM public.organizations
ON CONFLICT (org_id) DO NOTHING;

-- RLS: org admins read; service role writes
ALTER TABLE public.org_quotas ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_quotas_admin_read ON public.org_quotas
  FOR SELECT
  USING (public.is_org_member(org_id, 'admin'));

-- =============================================================
-- 4. vendor_webhook_deliveries (partitioned, #39 stub)
-- =============================================================
-- Hot append-only table. Retention: 60d. Partitioned monthly.
-- Populated by the jobs-worker-cron webhook_delivery handler.
-- =============================================================

CREATE TABLE public.vendor_webhook_deliveries (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  job_id        uuid,
  org_id        uuid        NOT NULL REFERENCES public.organizations(id),
  endpoint_url  text        NOT NULL,
  event_type    text        NOT NULL,
  payload       jsonb       NOT NULL,
  status_code   int,
  response_body text,
  attempt       int         NOT NULL DEFAULT 1,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX vwd_org_status_idx  ON public.vendor_webhook_deliveries (org_id, delivered_at);
CREATE INDEX vwd_job_idx         ON public.vendor_webhook_deliveries (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX vwd_created_idx     ON public.vendor_webhook_deliveries (created_at);

CREATE TABLE public.vendor_webhook_deliveries_2026_05 PARTITION OF public.vendor_webhook_deliveries
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE public.vendor_webhook_deliveries_2026_06 PARTITION OF public.vendor_webhook_deliveries
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE public.vendor_webhook_deliveries_2026_07 PARTITION OF public.vendor_webhook_deliveries
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

ALTER TABLE public.vendor_webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY vwd_org_read ON public.vendor_webhook_deliveries
  FOR SELECT
  USING (org_id = ANY(SELECT public.my_org_ids()));

-- =============================================================
-- 5. Partition-rotation helper function
-- =============================================================
-- Called by partition-rotation-cron Edge Function monthly.
-- Creates the next month's partition for every partitioned table
-- and optionally detaches expired partitions per retention.
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_next_month_partitions(
  p_month_start date  -- first day of the month to create (next month)
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
    'vendor_webhook_deliveries'
    -- future tables: 'analytics_events','analytics_daily','usage_events',
    --                'credit_transactions','run_steps','notifications'
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
-- 6. Trigger: auto-provision org_quotas on org creation
-- =============================================================

CREATE OR REPLACE FUNCTION public.provision_org_quotas()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.org_quotas (org_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_provision_quotas
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.provision_org_quotas();
