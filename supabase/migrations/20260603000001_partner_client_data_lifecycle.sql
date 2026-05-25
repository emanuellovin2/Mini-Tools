-- #45 Partner-client data lifecycle & DPA
-- Adds: partner_clients (CRM identity registry), partner_data_requests (export/erasure tracking),
-- retention cron for high-PII stores, and RLS trust boundaries per SPEC §13.

-- ---------------------------------------------------------------------------
-- 1. partner_clients — canonical PII registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_clients (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_owner_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  external_ref      text,
  email             text,
  display_name      text,
  -- CRM seam fields (cost nothing now, avoids re-migration for client tagging)
  tags              text[]      NOT NULL DEFAULT '{}',
  lifecycle_stage   text,       -- free-form: lead|active|churned|...
  notes             text,
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz            -- soft-delete tombstone; halts processing
);

-- Unique per (partner_owner_id, external_ref) when ref is provided
CREATE UNIQUE INDEX IF NOT EXISTS partner_clients_owner_ref_uidx
  ON public.partner_clients (partner_owner_id, external_ref)
  WHERE external_ref IS NOT NULL;

-- Fast lookup by owner org + soft-delete filter
CREATE INDEX IF NOT EXISTS partner_clients_owner_active_idx
  ON public.partner_clients (partner_owner_id)
  WHERE deleted_at IS NULL;

-- Retention purge index: find old soft-deleted rows
CREATE INDEX IF NOT EXISTS partner_clients_deleted_at_idx
  ON public.partner_clients (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- RLS: only partner_owner_id org members + admin
ALTER TABLE public.partner_clients ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'partner_clients' AND policyname = 'partner_clients_owner_rls'
  ) THEN
    CREATE POLICY partner_clients_owner_rls ON public.partner_clients
      FOR ALL
      USING (is_org_member(partner_owner_id));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. partner_data_requests — tracks export / erasure jobs
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.data_request_type AS ENUM ('export', 'erasure');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.data_request_status AS ENUM ('pending', 'processing', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.partner_data_requests (
  id                  uuid                             PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_owner_id    uuid                             NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_client_id   uuid                             NOT NULL REFERENCES public.partner_clients(id) ON DELETE CASCADE,
  request_type        public.data_request_type         NOT NULL,
  status              public.data_request_status       NOT NULL DEFAULT 'pending',
  -- For erasure: immediate soft-delete, hard erasure after grace
  grace_ends_at       timestamptz,
  -- Link to the background job that executes this
  job_id              uuid,
  -- Download link for export requests (signed URL, short-lived)
  result_url          text,
  created_by          uuid REFERENCES auth.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);

CREATE INDEX IF NOT EXISTS partner_data_requests_owner_idx
  ON public.partner_data_requests (partner_owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS partner_data_requests_client_idx
  ON public.partner_data_requests (partner_client_id);

ALTER TABLE public.partner_data_requests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'partner_data_requests' AND policyname = 'data_requests_owner_rls'
  ) THEN
    CREATE POLICY data_requests_owner_rls ON public.partner_data_requests
      FOR ALL
      USING (is_org_member(partner_owner_id));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. usage_events: add partner_client_id linkage column
--    (nullable — existing rows have no client linkage; new metered calls set it)
-- ---------------------------------------------------------------------------
ALTER TABLE public.usage_events
  ADD COLUMN IF NOT EXISTS partner_client_id uuid REFERENCES public.partner_clients(id);

CREATE INDEX IF NOT EXISTS usage_events_partner_client_idx
  ON public.usage_events (partner_client_id)
  WHERE partner_client_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. workflow_runs / run_steps: add partner_client_id for I/O erasure scope
-- ---------------------------------------------------------------------------
ALTER TABLE public.workflow_runs
  ADD COLUMN IF NOT EXISTS partner_client_id uuid REFERENCES public.partner_clients(id);

CREATE INDEX IF NOT EXISTS workflow_runs_partner_client_idx
  ON public.workflow_runs (partner_client_id)
  WHERE partner_client_id IS NOT NULL;

-- run_steps I/O is purged by erasure — no FK needed, purged via run join

-- ---------------------------------------------------------------------------
-- 5. pg_cron — retention purge for high-PII stores (every day at 04:00 UTC)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$
      SELECT cron.schedule(
        'retention-purge-cron',
        '0 4 * * *',
        $cmd$
          UPDATE public.run_steps
             SET input  = NULL,
                 output = NULL
           WHERE created_at < now() - interval '90 days'
             AND (input IS NOT NULL OR output IS NOT NULL);

          DELETE FROM public.partner_clients
           WHERE deleted_at IS NOT NULL
             AND deleted_at < now() - interval '30 days';
        $cmd$
      )
    $q$;
  END IF;
END $$;
