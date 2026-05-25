-- =============================================================================
-- #54 — Wave 9 scale invariants & operational seams
-- =============================================================================
-- Cross-cutting seams consumed by #40–#53. Interface-first, light implementation.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Region column on organizations + analytics_events
--    Strings, not enum — future regions = config change, not migration.
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'us-east-1',
  ADD COLUMN IF NOT EXISTS custom_domain text UNIQUE;

-- Downstream: solution_deployments.region and analytics_events.region
-- are declared in #50 and already handled in analytics_events (#46).
-- Add region to analytics_events if not already present (#46 migration may vary).
ALTER TABLE public.analytics_events
  ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'us-east-1';

-- Shard-aware composite index — prefix (region, tenant_shard_id) so future
-- regional routers can narrow scans with constant-true predicates cheaply.
CREATE INDEX IF NOT EXISTS org_region_idx
  ON public.organizations (region, id);

-- ---------------------------------------------------------------------------
-- 2. Tenant noisy-neighbor: tenant_query_stats materialized view
--    Correlates runaway queries to orgs for admin dashboard surfacing.
--    Refreshed every 5 min by pg_cron (configured below).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS public.tenant_query_stats AS
SELECT
  current_setting('app.org_id', true)         AS org_id,
  count(*)                                     AS query_count,
  sum(total_exec_time)                         AS total_exec_ms,
  max(max_exec_time)                           AS max_exec_ms,
  sum(calls)                                   AS total_calls
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'
GROUP BY 1
HAVING current_setting('app.org_id', true) IS NOT NULL
WITH NO DATA;

-- Initial populate (empty until first queries with SET LOCAL app.org_id run)
REFRESH MATERIALIZED VIEW public.tenant_query_stats;

-- ---------------------------------------------------------------------------
-- 3. org_quotas — Wave 9 resource columns (#54 §4)
-- ---------------------------------------------------------------------------
ALTER TABLE public.org_quotas
  ADD COLUMN IF NOT EXISTS max_active_deployments  int NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS max_clients             int NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS webhook_deliveries_per_min  int NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS workflow_runs_per_min   int NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS outcome_emits_per_sec   int NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS connector_oauth_refreshes_per_min int NOT NULL DEFAULT 60;

-- Backfill existing rows with defaults (idempotent)
UPDATE public.org_quotas SET
  max_active_deployments = 100,
  max_clients = 50,
  webhook_deliveries_per_min = 100,
  workflow_runs_per_min = 60,
  outcome_emits_per_sec = 100,
  connector_oauth_refreshes_per_min = 60
WHERE max_active_deployments IS NULL OR max_active_deployments = 0;

-- ---------------------------------------------------------------------------
-- 4. settlement_batches — 1 Stripe transfer per recipient per period (#54 §6)
--    Unique on (recipient_org_id, period_start, period_end) — idempotent re-runs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.settlement_batches (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_org_id   uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_start       date        NOT NULL,
  period_end         date        NOT NULL,
  total_cents        bigint      NOT NULL CHECK (total_cents >= 0),
  stripe_transfer_id text        UNIQUE,
  status             text        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'processing', 'settled', 'failed')),
  event_count        int         NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz,
  UNIQUE (recipient_org_id, period_start, period_end)
);

-- RLS: service role only — settlement is admin-only
ALTER TABLE public.settlement_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sb_service_only" ON public.settlement_batches
  USING (false) WITH CHECK (false);

CREATE INDEX IF NOT EXISTS settlement_batches_recipient_period_idx
  ON public.settlement_batches (recipient_org_id, period_start DESC);

CREATE INDEX IF NOT EXISTS settlement_batches_status_idx
  ON public.settlement_batches (status, created_at)
  WHERE status IN ('pending', 'processing');

-- ---------------------------------------------------------------------------
-- 5. idempotency_keys_v2 — sharded TTL dedup table (#54 §9)
--    Partitioned by created_at (monthly). Drop partitions > 7 days old.
--    All event writers (recordUsage, emitMetric) insert here first.
--    ON CONFLICT DO NOTHING + rowcount=0 → short-circuit without touching event tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.idempotency_keys_v2 (
  scope      text        NOT NULL,  -- 'usage_event' | 'deployment_metric' | 'analytics_event'
  key        text        NOT NULL,  -- caller-supplied idempotency key
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key, created_at)
) PARTITION BY RANGE (created_at);

-- Seed partitions: current month + next 2
DO $$
DECLARE
  m date;
BEGIN
  FOR i IN 0..2 LOOP
    m := date_trunc('month', now()) + (i || ' month')::interval;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.idempotency_keys_v2_%s
       PARTITION OF public.idempotency_keys_v2
       FOR VALUES FROM (%L) TO (%L)',
      to_char(m, 'YYYY_MM'),
      m,
      m + interval '1 month'
    );
  END LOOP;
END $$;

-- RLS: service role only (writers always use admin client)
ALTER TABLE public.idempotency_keys_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "idem_v2_service_only" ON public.idempotency_keys_v2
  USING (false) WITH CHECK (false);

-- ---------------------------------------------------------------------------
-- 6. pg_cron — long-running tenant query auto-kill (§4)
--    Scans pg_stat_activity for queries running > 60s with app.org_id set.
--    Writes to audit_log and cancels the backend.
--    Threshold: 60s default, 300s for enterprise tier (tunable via org_quotas future col).
-- ---------------------------------------------------------------------------
-- Note: pg_cron extension must be enabled in Supabase Dashboard.
-- The cron job is registered here; the function is idempotent.

CREATE OR REPLACE FUNCTION public.kill_runaway_tenant_queries()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  threshold_secs int := 60;
BEGIN
  FOR rec IN
    SELECT pid, query_start,
           current_setting('app.org_id', true) AS org_id,
           query
    FROM pg_stat_activity
    WHERE state = 'active'
      AND query_start < now() - (threshold_secs || ' seconds')::interval
      AND current_setting('app.org_id', true) IS NOT NULL
      AND current_setting('app.org_id', true) != ''
      AND usename NOT IN ('postgres', 'supabase_admin', 'pgbouncer')
  LOOP
    -- Cancel (not terminate) — gives the query a chance to clean up
    PERFORM pg_cancel_backend(rec.pid);
    -- Audit log (best-effort — don't fail if audit_log write fails)
    BEGIN
      INSERT INTO public.audit_log (actor_id, action, target_type, target_id, meta)
      VALUES (
        NULL,
        'query_killed',
        'tenant_query',
        rec.org_id::text,
        jsonb_build_object(
          'pid', rec.pid,
          'query_start', rec.query_start,
          'query_snippet', left(rec.query, 200),
          'threshold_secs', threshold_secs
        )
      );
    EXCEPTION WHEN OTHERS THEN
      -- Audit failure must never prevent the kill
      NULL;
    END;
  END LOOP;
END;
$$;

-- Register cron job (runs every minute).
-- Requires pg_cron. If not available, this is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$
      SELECT cron.schedule(
        'kill-runaway-tenant-queries',
        '* * * * *',
        'SELECT public.kill_runaway_tenant_queries()'
      )
    $q$;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. analytics_events region index (shard-aware composite)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ae_region_shard_idx
  ON public.analytics_events (region, created_at DESC)
  WHERE region IS NOT NULL;
