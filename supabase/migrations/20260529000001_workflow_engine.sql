-- =============================================================================
-- #42 — Workflow / automation engine
-- =============================================================================
-- workflows, workflow_steps (editable draft), workflow_versions (immutable),
-- workflow_runs (durable state machine), run_steps (checkpoints),
-- RLS trust boundaries, quota defaults, trigger webhook secret,
-- org_quotas column additions.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. workflows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workflows (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- org_id is the owning org; team members operate per org_members.role
  org_id          uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- optional: deployment this workflow runs within (non-SaaS solutions)
  deployment_id   uuid        REFERENCES public.solution_deployments(id) ON DELETE SET NULL,
  name            text        NOT NULL,
  status          text        NOT NULL DEFAULT 'draft'   CHECK (status IN ('draft', 'active', 'paused')),
  trigger_type    text        NOT NULL DEFAULT 'manual'  CHECK (trigger_type IN ('manual', 'schedule', 'webhook')),
  trigger_config  jsonb       NOT NULL DEFAULT '{}',
  -- webhook trigger: HMAC-SHA256 secret; NULL unless trigger_type='webhook'
  webhook_secret  text,
  -- per-run billing meter (product_type='workflow'); NULL = unmetered
  meter_id        uuid        REFERENCES public.usage_meters(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workflows_name_nonempty CHECK (length(trim(name)) > 0),
  CONSTRAINT workflows_name_len      CHECK (length(name) <= 200),
  CONSTRAINT workflows_webhook_secret_when_type
    CHECK (trigger_type != 'webhook' OR webhook_secret IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS workflows_org_id_idx ON public.workflows (org_id);
CREATE INDEX IF NOT EXISTS workflows_deployment_id_idx ON public.workflows (deployment_id) WHERE deployment_id IS NOT NULL;

ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflows_member_select" ON public.workflows
  FOR SELECT USING (is_org_member(org_id));

CREATE POLICY "workflows_member_insert" ON public.workflows
  FOR INSERT WITH CHECK (is_org_member(org_id));

CREATE POLICY "workflows_member_update" ON public.workflows
  FOR UPDATE USING (is_org_member(org_id));

CREATE POLICY "workflows_member_delete" ON public.workflows
  FOR DELETE USING (is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- 2. workflow_steps (editable draft step definitions; one row per step in a workflow)
--    These are the "live" definition the builder edits. publishVersion snapshots them
--    into workflow_versions.graph. Counted for the max_workflow_steps quota.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workflow_steps (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workflow_id uuid        NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  -- org_id denormalised for quota enforcement (enforceQuota uses orgCol='org_id')
  org_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  step_key    text        NOT NULL, -- unique slug within the workflow
  step_type   text        NOT NULL CHECK (step_type IN ('ai', 'http', 'transform', 'branch', 'delay', 'connector')),
  config      jsonb       NOT NULL DEFAULT '{}',
  position    int         NOT NULL DEFAULT 0,
  -- key of the step to run after this one; NULL = terminal
  next_step_key text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workflow_steps_step_key_nonempty CHECK (length(trim(step_key)) > 0),
  CONSTRAINT workflow_steps_step_key_len      CHECK (length(step_key) <= 100),
  UNIQUE (workflow_id, step_key)
);

CREATE INDEX IF NOT EXISTS workflow_steps_workflow_id_idx ON public.workflow_steps (workflow_id);
CREATE INDEX IF NOT EXISTS workflow_steps_org_id_idx      ON public.workflow_steps (org_id);

ALTER TABLE public.workflow_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_steps_member_select" ON public.workflow_steps
  FOR SELECT USING (is_org_member(org_id));

CREATE POLICY "workflow_steps_member_insert" ON public.workflow_steps
  FOR INSERT WITH CHECK (is_org_member(org_id));

CREATE POLICY "workflow_steps_member_update" ON public.workflow_steps
  FOR UPDATE USING (is_org_member(org_id));

CREATE POLICY "workflow_steps_member_delete" ON public.workflow_steps
  FOR DELETE USING (is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- 3. workflow_versions (immutable published snapshots; runs pin a version)
--    `graph` contains the full ordered steps/edges as jsonb at publish time.
--    Capped at 50 versions per workflow.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workflow_versions (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workflow_id     uuid        NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  version         int         NOT NULL,
  -- Snapshot of all steps: { start_step_key, steps: { [key]: { type, config, next_step_key, branches? } } }
  graph           jsonb       NOT NULL,
  -- Template support: if this version is published as a template product
  is_template     bool        NOT NULL DEFAULT false,
  template_of_id  uuid        REFERENCES public.workflow_versions(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workflow_versions_version_positive CHECK (version > 0),
  UNIQUE (workflow_id, version)
);

CREATE INDEX IF NOT EXISTS workflow_versions_workflow_id_idx ON public.workflow_versions (workflow_id);

-- Immutable: no UPDATE or DELETE via RLS (service-role bypasses for admin ops)
ALTER TABLE public.workflow_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_versions_member_select" ON public.workflow_versions
  FOR SELECT USING (
    workflow_id IN (SELECT id FROM public.workflows WHERE is_org_member(org_id))
  );

-- INSERT allowed (publishing); no UPDATE or DELETE policies → immutable via RLS
CREATE POLICY "workflow_versions_member_insert" ON public.workflow_versions
  FOR INSERT WITH CHECK (
    workflow_id IN (SELECT id FROM public.workflows WHERE is_org_member(org_id))
  );

-- ---------------------------------------------------------------------------
-- 4. workflow_runs (durable state machine; advanced one slice per cron tick)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workflow_runs (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workflow_id     uuid        NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  version_id      uuid        NOT NULL REFERENCES public.workflow_versions(id),
  -- deployment context (inherits from workflow if set)
  deployment_id   uuid        REFERENCES public.solution_deployments(id) ON DELETE SET NULL,
  status          text        NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  trigger_payload jsonb,
  -- durable state machine cursor
  next_step_key   text,       -- NULL = run is complete (no more steps to execute)
  next_run_at     timestamptz NOT NULL DEFAULT now(),
  -- attempt counter (retried if executor crashes before marking complete)
  executor_attempt int        NOT NULL DEFAULT 0,
  started_at      timestamptz,
  finished_at     timestamptz,
  error           text,
  -- usage_event_id is set after the first metering call; prevents double-charge on retry
  usage_event_id  uuid,
  idempotency_key text        UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Hot path: cron claims runs due for execution
CREATE INDEX IF NOT EXISTS workflow_runs_due_idx ON public.workflow_runs (next_run_at, status)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS workflow_runs_workflow_id_idx ON public.workflow_runs (workflow_id);

ALTER TABLE public.workflow_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_runs_member_select" ON public.workflow_runs
  FOR SELECT USING (
    workflow_id IN (SELECT id FROM public.workflows WHERE is_org_member(org_id))
  );

-- Runs are inserted by the service layer via service-role client; no INSERT policy needed

-- ---------------------------------------------------------------------------
-- 5. run_steps (per-step durable checkpoints; idempotent on retry)
--    I/O (input/output) is NOT accessible cross-owner — enforced via RLS.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.run_steps (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id      uuid        NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_key    text        NOT NULL,
  step_type   text        NOT NULL,
  status      text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  input       jsonb,
  output      jsonb,
  attempt     int         NOT NULL DEFAULT 1,
  error       text,
  started_at  timestamptz,
  finished_at timestamptz,
  -- Per-step idempotency: `{run_id}:{step_key}:{attempt}`
  -- Prevents duplicate side effects on executor crash + re-claim
  idempotency_key text    UNIQUE,

  UNIQUE (run_id, step_key, attempt)
);

CREATE INDEX IF NOT EXISTS run_steps_run_id_idx ON public.run_steps (run_id);

-- RLS: step I/O never readable cross-owner — user must own the parent workflow
ALTER TABLE public.run_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "run_steps_member_select" ON public.run_steps
  FOR SELECT USING (
    run_id IN (
      SELECT wr.id FROM public.workflow_runs wr
      JOIN public.workflows w ON w.id = wr.workflow_id
      WHERE is_org_member(w.org_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 6. org_quotas: ensure max_workflows + max_workflow_steps columns exist
--    (originally added in #48 migration; ADD COLUMN IF NOT EXISTS is safe to re-run)
-- ---------------------------------------------------------------------------
ALTER TABLE public.org_quotas
  ADD COLUMN IF NOT EXISTS max_workflows      int NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS max_workflow_steps int NOT NULL DEFAULT 50;

-- ---------------------------------------------------------------------------
-- 7. Trigger function to enforce max 50 versions per workflow
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_workflow_version_cap()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.workflow_versions
  WHERE workflow_id = NEW.workflow_id;

  IF v_count >= 50 THEN
    RAISE EXCEPTION 'workflow_versions: max 50 versions per workflow (workflow_id=%)' , NEW.workflow_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_version_cap ON public.workflow_versions;
CREATE TRIGGER trg_workflow_version_cap
  BEFORE INSERT ON public.workflow_versions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workflow_version_cap();

-- ---------------------------------------------------------------------------
-- 8. Trigger to update workflows.updated_at on workflow_steps change
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_workflow_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.workflows SET updated_at = now() WHERE id = COALESCE(NEW.workflow_id, OLD.workflow_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_steps_touch ON public.workflow_steps;
CREATE TRIGGER trg_workflow_steps_touch
  AFTER INSERT OR UPDATE OR DELETE ON public.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION public.touch_workflow_updated_at();

-- ---------------------------------------------------------------------------
-- 9. RPC: claim_workflow_run — atomically claims one due run for a worker.
--    Returns NULL if no run is due. Uses SKIP LOCKED to avoid contention.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_workflow_run(p_worker_id text)
RETURNS SETOF public.workflow_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.workflow_runs;
BEGIN
  SELECT * INTO v_run
  FROM public.workflow_runs
  WHERE status IN ('queued', 'running')
    AND next_run_at <= now()
  ORDER BY next_run_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_run IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.workflow_runs
  SET status           = 'running',
      executor_attempt = executor_attempt + 1,
      started_at       = COALESCE(started_at, now())
  WHERE id = v_run.id
  RETURNING * INTO v_run;

  RETURN NEXT v_run;
END;
$$;
