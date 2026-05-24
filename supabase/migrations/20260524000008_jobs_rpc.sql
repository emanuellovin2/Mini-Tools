-- =============================================================
-- Migration #48b: Postgres helpers for job worker
-- =============================================================

-- Atomic job claim via SKIP LOCKED.
-- Returns up to p_limit jobs that are ready to run.
-- Sets status=running, locked_by, locked_until in one UPDATE.

CREATE OR REPLACE FUNCTION public.claim_jobs(
  p_worker_id   text,
  p_limit       int,
  p_now         timestamptz,
  p_locked_until timestamptz
)
RETURNS SETOF public.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.jobs
  SET
    status       = 'running',
    locked_by    = p_worker_id,
    locked_until = p_locked_until,
    attempts     = attempts + 1
  WHERE id IN (
    SELECT id FROM public.jobs
    WHERE status IN ('queued', 'failed')
      AND next_run_at <= p_now
      AND (locked_until IS NULL OR locked_until < p_now)
    ORDER BY next_run_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

-- SET LOCAL statement_timeout helper
-- Called by withStatementTimeout() in lib/db/with-timeout.ts

CREATE OR REPLACE FUNCTION public.set_statement_timeout(p_ms int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  EXECUTE format('SET LOCAL statement_timeout = %L', p_ms || 'ms');
END;
$$;
