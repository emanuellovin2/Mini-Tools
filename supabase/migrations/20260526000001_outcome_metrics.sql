-- =============================================================================
-- #51 — Outcome metrics seam
-- =============================================================================
-- deployment_metrics (daily partition, append-only), deployment_metrics_rollup
-- (watermark-driven, indefinite), PII dimensions guard, RLS trust boundaries,
-- rollup RPC, k≥5 benchmark function, archive router stub.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. PII check helper — IMMUTABLE so it can be used in CHECK constraints.
--    Rejects dimension values that look like emails, phone numbers, or PANs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dimensions_has_pii(dims jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  IF dims IS NULL THEN RETURN false; END IF;
  FOR v IN SELECT value FROM jsonb_each_text(dims) LOOP
    -- Email: local@domain.tld pattern
    IF v ~* '^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$' THEN RETURN true; END IF;
    -- Phone: 7–15 digits with optional +/dash/space/parens and at least 7 consecutive digits
    IF v ~ '^\+?[\d\s\-(). ]{7,18}$' AND v ~ '\d{7}' THEN RETURN true; END IF;
    -- PAN: 13–19 consecutive digits (credit/debit card)
    IF v ~ '^\d{13,19}$' THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END;
$$;

-- Helper: count keys in a jsonb object (IMMUTABLE for use in CHECK constraints)
CREATE OR REPLACE FUNCTION public.jsonb_key_count(j jsonb)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT count(*)::int FROM jsonb_object_keys(j);
$$;

-- Helper: max value length in a jsonb object
CREATE OR REPLACE FUNCTION public.jsonb_max_value_len(j jsonb)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(max(length(value)), 0) FROM jsonb_each_text(j);
$$;

-- ---------------------------------------------------------------------------
-- 1. deployment_metrics — append-only, daily partitioned
--    One row per metric emission from an agent/workflow/bundle deployment.
--    No UPDATE/DELETE — corrections via negative-value compensation rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deployment_metrics (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  -- First column of every composite index: enables future cross-cluster sharding
  -- by routing a deployment to a shard without rewriting service code.
  tenant_shard_id   smallint    NOT NULL DEFAULT 0,
  deployment_id     uuid        NOT NULL
                                REFERENCES public.solution_deployments(id) ON DELETE CASCADE,
  metric_key        text        NOT NULL
                                CHECK (metric_key ~ '^[a-z][a-z0-9._]*$'),
  metric_value      numeric(20,4) NOT NULL,
  -- Common units: 'count' | 'usd' | 'hours' | 'minutes' | 'percent' | freeform
  metric_unit       text        NOT NULL,
  dimensions        jsonb       NOT NULL DEFAULT '{}',
  -- Caller-provided idempotency key: (deployment_id, metric_key, idempotency_key) dedup
  idempotency_key   text,
  -- When the business outcome occurred (caller-supplied, may differ from insert time)
  emitted_at        timestamptz NOT NULL,
  -- Partition key — always use DEFAULT now(); never supply a future/past value outside
  -- the current partition window or the row will be rejected.
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dm_dimensions_max_keys CHECK (
    public.jsonb_key_count(dimensions) <= 16
  ),
  CONSTRAINT dm_dimensions_max_value_len CHECK (
    public.jsonb_max_value_len(dimensions) <= 64
  ),
  CONSTRAINT dm_dimensions_no_pii CHECK (
    NOT public.dimensions_has_pii(dimensions)
  )
) PARTITION BY RANGE (created_at);

-- Indexes on parent propagate to every partition automatically.
-- tenant_shard_id leads so a future shard router can add = ANY(shard_list) predicates cheaply.
CREATE INDEX IF NOT EXISTS dm_deploy_key_idx
  ON public.deployment_metrics (tenant_shard_id, deployment_id, metric_key, created_at DESC);

CREATE INDEX IF NOT EXISTS dm_deploy_emitted_idx
  ON public.deployment_metrics (tenant_shard_id, deployment_id, emitted_at DESC);

-- Partial unique for same-day idempotency at DB level (per-partition, created_at required).
-- Cross-day dedup is handled at the application layer (7-day window query).
CREATE UNIQUE INDEX IF NOT EXISTS dm_idempotency_idx
  ON public.deployment_metrics (deployment_id, metric_key, idempotency_key, created_at)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Seed initial daily partitions (current date + 13 days forward)
--    The partition-rotation-cron creates future ones; we seed 2 weeks to be safe.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  d date;
  tbl text;
  lo text;
  hi text;
BEGIN
  FOR d IN
    SELECT generate_series::date
    FROM generate_series(
      '2026-05-24'::date,
      '2026-06-06'::date,
      interval '1 day'
    )
  LOOP
    tbl := 'deployment_metrics_' || to_char(d, 'YYYY_MM_DD');
    lo  := to_char(d, 'YYYY-MM-DD');
    hi  := to_char(d + interval '1 day', 'YYYY-MM-DD');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.deployment_metrics
       FOR VALUES FROM (%L::timestamptz) TO (%L::timestamptz)',
      tbl, lo, hi
    );
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. create_daily_metric_partition — called by partition-rotation-cron daily
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_daily_metric_partition(p_date date)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tbl text := 'deployment_metrics_' || to_char(p_date, 'YYYY_MM_DD');
  lo  text := to_char(p_date, 'YYYY-MM-DD');
  hi  text := to_char(p_date + interval '1 day', 'YYYY-MM-DD');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.deployment_metrics
     FOR VALUES FROM (%L::timestamptz) TO (%L::timestamptz)',
    tbl, lo, hi
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. deployment_metrics_rollup — indefinite, watermark-driven daily summaries
--    Dashboards (#52, #53) ALWAYS read this table, never raw deployment_metrics.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deployment_metrics_rollup (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id     uuid        NOT NULL
                                REFERENCES public.solution_deployments(id) ON DELETE CASCADE,
  metric_key        text        NOT NULL,
  metric_unit       text        NOT NULL,
  -- md5(dimensions::text) — stable hash for grouping; original dimensions in raw table
  dimensions_hash   text        NOT NULL,
  date              date        NOT NULL,
  total_value       numeric(20,4) NOT NULL DEFAULT 0,
  raw_count         bigint      NOT NULL DEFAULT 0,
  -- Advances atomically on each rollup run; tracks furthest processed created_at
  rollup_watermark  timestamptz NOT NULL DEFAULT '-infinity',
  -- True when distinct dimension-value combos > 1000 for this (deployment, key, date)
  cardinality_overflow boolean  NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dmr_unique UNIQUE (deployment_id, metric_key, dimensions_hash, date)
);

CREATE INDEX IF NOT EXISTS dmr_deploy_date_idx
  ON public.deployment_metrics_rollup (deployment_id, date DESC, metric_key);

CREATE INDEX IF NOT EXISTS dmr_deploy_key_date_idx
  ON public.deployment_metrics_rollup (deployment_id, metric_key, date DESC);

-- ---------------------------------------------------------------------------
-- 5. RLS — deployment_metrics (append-only; no UPDATE/DELETE grants)
-- ---------------------------------------------------------------------------
ALTER TABLE public.deployment_metrics ENABLE ROW LEVEL SECURITY;

-- Client reads own deployments' metrics
CREATE POLICY dm_client_read ON public.deployment_metrics
  FOR SELECT
  USING (
    deployment_id IN (
      SELECT id FROM public.solution_deployments
      WHERE client_org_id = ANY(SELECT public.my_org_ids())
    )
  );

-- Agency reads metrics for deployments it operates
CREATE POLICY dm_agency_read ON public.deployment_metrics
  FOR SELECT
  USING (
    deployment_id IN (
      SELECT id FROM public.solution_deployments
      WHERE agency_org_id = ANY(SELECT public.my_org_ids())
    )
  );

-- Admin reads everything
CREATE POLICY dm_admin_read ON public.deployment_metrics
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- NOTE: No INSERT policy — service role bypasses RLS for writes.

-- ---------------------------------------------------------------------------
-- 6. RLS — deployment_metrics_rollup (same trust boundaries)
-- ---------------------------------------------------------------------------
ALTER TABLE public.deployment_metrics_rollup ENABLE ROW LEVEL SECURITY;

CREATE POLICY dmr_client_read ON public.deployment_metrics_rollup
  FOR SELECT
  USING (
    deployment_id IN (
      SELECT id FROM public.solution_deployments
      WHERE client_org_id = ANY(SELECT public.my_org_ids())
    )
  );

CREATE POLICY dmr_agency_read ON public.deployment_metrics_rollup
  FOR SELECT
  USING (
    deployment_id IN (
      SELECT id FROM public.solution_deployments
      WHERE agency_org_id = ANY(SELECT public.my_org_ids())
    )
  );

CREATE POLICY dmr_admin_read ON public.deployment_metrics_rollup
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- 7. rollup_outcomes_window — incremental watermark-driven rollup for one date
--    Idempotent: re-running for the same date with no new data is a no-op.
--    Called by the outcomes-rollup-cron job handler.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rollup_outcomes_window(p_date date)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since     timestamptz := p_date::timestamptz;
  v_until     timestamptz := LEAST(p_date::timestamptz + interval '1 day', now());
  v_rows_rolled int;
BEGIN
  -- Upsert full-day totals for the given date.
  -- ON CONFLICT advances totals only when the new watermark is later than the stored one
  -- (ensures re-running for same window is a no-op if no new rows arrived).
  WITH day_agg AS (
    SELECT
      dm.deployment_id,
      dm.metric_key,
      MAX(dm.metric_unit)                  AS metric_unit,
      md5(dm.dimensions::text)             AS dimensions_hash,
      SUM(dm.metric_value)                 AS total_value,
      COUNT(*)                             AS raw_count,
      MAX(dm.created_at)                   AS new_watermark,
      -- Flag: more than 1000 distinct dimension-value combos for this group today
      (COUNT(DISTINCT dm.dimensions::text) > 1000) AS cardinality_overflow
    FROM public.deployment_metrics dm
    WHERE dm.created_at >= v_since
      AND dm.created_at < v_until
    GROUP BY dm.deployment_id, dm.metric_key, md5(dm.dimensions::text)
  )
  INSERT INTO public.deployment_metrics_rollup (
    deployment_id, metric_key, metric_unit, dimensions_hash, date,
    total_value, raw_count, rollup_watermark, cardinality_overflow, updated_at
  )
  SELECT
    deployment_id, metric_key, metric_unit, dimensions_hash, p_date,
    total_value, raw_count, new_watermark, cardinality_overflow, now()
  FROM day_agg
  ON CONFLICT (deployment_id, metric_key, dimensions_hash, date)
  DO UPDATE SET
    total_value          = EXCLUDED.total_value,
    raw_count            = EXCLUDED.raw_count,
    rollup_watermark     = EXCLUDED.rollup_watermark,
    cardinality_overflow = EXCLUDED.cardinality_overflow,
    updated_at           = EXCLUDED.updated_at
  WHERE deployment_metrics_rollup.rollup_watermark < EXCLUDED.rollup_watermark;

  GET DIAGNOSTICS v_rows_rolled = ROW_COUNT;
  RETURN jsonb_build_object('date', p_date, 'rows_rolled', v_rows_rolled);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. get_solution_outcome_benchmarks — k≥5 anonymity guard
--    Returns anonymous aggregates (median, p25/p75) across all deployments of a
--    solution. Strips per-deployment and per-org identity. Vendor-callable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_solution_outcome_benchmarks(p_solution_id uuid)
RETURNS TABLE (
  metric_key        text,
  metric_unit       text,
  median_value      numeric,
  p25_value         numeric,
  p75_value         numeric,
  deployment_count  bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.metric_key,
    MAX(r.metric_unit)                                                  AS metric_unit,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.total_value)         AS median_value,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY r.total_value)        AS p25_value,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY r.total_value)        AS p75_value,
    COUNT(DISTINCT r.deployment_id)                                     AS deployment_count
  FROM public.deployment_metrics_rollup r
  JOIN public.solution_deployments sd ON sd.id = r.deployment_id
  WHERE sd.solution_id = p_solution_id
  GROUP BY r.metric_key
  HAVING COUNT(DISTINCT r.deployment_id) >= 5;
$$;

-- ---------------------------------------------------------------------------
-- 9. outcomes_archive_router — stub that reads the hot rollup table.
--    Full S3 cold-storage path is a future ops task (post-24mo).
--    Dashboards call this, never the rollup table directly, so the swap is transparent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.outcomes_archive_router(
  p_deployment_id uuid,
  p_since         date,
  p_until         date
)
RETURNS TABLE (
  deployment_id     uuid,
  metric_key        text,
  metric_unit       text,
  dimensions_hash   text,
  date              date,
  total_value       numeric,
  raw_count         bigint,
  cardinality_overflow boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  -- Stub: always reads hot table. Future: route p_until < now() - interval '24 months'
  -- to S3 parquet via archive query and return a job_id for async delivery.
  SELECT
    deployment_id, metric_key, metric_unit, dimensions_hash, date,
    total_value, raw_count, cardinality_overflow
  FROM public.deployment_metrics_rollup
  WHERE deployment_id = p_deployment_id
    AND date >= p_since
    AND date <= p_until
  ORDER BY date DESC;
$$;

-- ---------------------------------------------------------------------------
-- 10. org_quotas: outcome_emits_per_sec column already added by #54.
--     Add max_deployment_metrics quota (cap on historical rollup rows per org).
-- ---------------------------------------------------------------------------
ALTER TABLE public.org_quotas
  ADD COLUMN IF NOT EXISTS max_deployment_metric_keys int NOT NULL DEFAULT 200;

UPDATE public.org_quotas
SET max_deployment_metric_keys = 200
WHERE max_deployment_metric_keys IS NULL;

-- ---------------------------------------------------------------------------
-- 11. pg_cron: outcomes rollup every 15 minutes
--     Calls rollup_outcomes_window for today and yesterday (catch-up).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$
      SELECT cron.schedule(
        'outcomes-rollup-cron',
        '*/15 * * * *',
        $cmd$
          SELECT rollup_outcomes_window(CURRENT_DATE);
          SELECT rollup_outcomes_window(CURRENT_DATE - 1);
        $cmd$
      )
    $q$;
  END IF;
END $$;

-- pg_cron: create tomorrow's daily partition each night at 00:10 UTC
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$
      SELECT cron.schedule(
        'metrics-daily-partition-cron',
        '10 0 * * *',
        $cmd$
          SELECT create_daily_metric_partition(CURRENT_DATE + 1);
          SELECT create_daily_metric_partition(CURRENT_DATE + 2);
        $cmd$
      )
    $q$;
  END IF;
END $$;

-- pg_cron: detach deployment_metrics partitions older than 90 days
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$
      SELECT cron.schedule(
        'metrics-daily-partition-detach-cron',
        '20 0 * * *',
        $cmd$
          DO $inner$
          DECLARE
            cutoff date := CURRENT_DATE - 90;
            tbl text := 'deployment_metrics_' || to_char(cutoff, 'YYYY_MM_DD');
          BEGIN
            EXECUTE format(
              'ALTER TABLE public.deployment_metrics DETACH PARTITION IF EXISTS public.%I',
              tbl
            );
          END;
          $inner$
        $cmd$
      )
    $q$;
  END IF;
END $$;
