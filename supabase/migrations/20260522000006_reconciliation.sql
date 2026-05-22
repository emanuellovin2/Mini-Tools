-- ============================================================
-- Migration #12: reconciliation_runs
-- Stores results of the daily Stripe↔DB reconciliation job.
-- ============================================================

CREATE TYPE public.reconciliation_status AS ENUM ('ok', 'drift_found', 'failed');

CREATE TABLE public.reconciliation_runs (
  id          uuid                            PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at      timestamptz                     NOT NULL DEFAULT now(),
  status      public.reconciliation_status    NOT NULL,
  drift_items jsonb                           NOT NULL DEFAULT '[]'::jsonb,
  drift_count int                             NOT NULL DEFAULT 0 CHECK (drift_count >= 0),
  error       text,
  created_at  timestamptz                     NOT NULL DEFAULT now()
);

CREATE INDEX reconciliation_runs_run_at_idx ON public.reconciliation_runs (run_at DESC);

-- RLS: service role writes; admin reads.
ALTER TABLE public.reconciliation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reconciliation_runs_select_admin"
  ON public.reconciliation_runs FOR SELECT
  USING (public.get_current_user_role() = 'admin');
