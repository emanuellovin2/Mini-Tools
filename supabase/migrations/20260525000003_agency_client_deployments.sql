-- =============================================================================
-- #50 — Agency ↔ Client relationships + Solution deployments
-- =============================================================================
-- Extends organization_type with 'agency' and 'client'; creates client_relationships
-- (one active agency per client) and solution_deployments (operational unit for
-- non-SaaS solutions). Enforces RLS trust boundaries and hot composite indexes.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extend organizations.type CHECK constraint
--    Text CHECK, not a PG enum — drop and re-add is instant (no table rewrite).
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_type_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_type_check
  CHECK (type IN ('personal', 'team', 'agency', 'client'));

-- ---------------------------------------------------------------------------
-- 2. client_relationships — binds one agency to one client at a time
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_relationships (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_org_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  client_org_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status         text        NOT NULL DEFAULT 'invited'
                             CHECK (status IN ('invited','active','paused','ended')),
  invited_at     timestamptz NOT NULL DEFAULT now(),
  accepted_at    timestamptz,
  ended_at       timestamptz,
  ended_reason   text        CHECK (ended_reason IN ('client_cancelled','agency_dropped','admin_action')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cr_no_self_relationship CHECK (agency_org_id <> client_org_id)
);

-- Partial unique: at most ONE active agency per client. Easily lifted by dropping the WHERE.
CREATE UNIQUE INDEX IF NOT EXISTS cr_one_active_agency_per_client
  ON public.client_relationships (client_org_id)
  WHERE status = 'active';

-- Agency dashboard: list all clients for a given agency, filtered by status.
CREATE INDEX CONCURRENTLY IF NOT EXISTS cr_agency_status_accepted_idx
  ON public.client_relationships (agency_org_id, status, accepted_at DESC)
  WHERE status = 'active';

CREATE INDEX CONCURRENTLY IF NOT EXISTS cr_agency_all_idx
  ON public.client_relationships (agency_org_id, status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS cr_client_idx
  ON public.client_relationships (client_org_id, status);

-- ---------------------------------------------------------------------------
-- 3. solution_deployments — operational unit for agent/workflow/bundle solutions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.solution_deployments (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Sharding seam: first column of every composite index. Default 0 (single-shard launch).
  tenant_shard_id         smallint    NOT NULL DEFAULT 0,
  solution_id             uuid        NOT NULL REFERENCES public.solutions(id) ON DELETE RESTRICT,
  client_org_id           uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- The agency operating this deployment; NULL = client self-operates (marketplace-direct).
  agency_org_id           uuid        REFERENCES public.organizations(id) ON DELETE SET NULL,
  -- Denormalized template origin at deploy time (from solutions.template_of_id).
  template_origin_id      uuid        REFERENCES public.solutions(id) ON DELETE SET NULL,
  status                  text        NOT NULL DEFAULT 'pending_setup'
                                      CHECK (status IN (
                                        'pending_setup','active','paused','failed',
                                        'archived','orphaned'
                                      )),
  -- Merge-patched onto solutions.runtime_config at runtime (validated per type).
  runtime_config_override jsonb,
  -- { logo_url, brand_color, display_name } — applied on client-facing surfaces.
  branding                jsonb,
  -- Which credit wallet (#40) is debited per usage event.
  credit_wallet_owner     text        NOT NULL DEFAULT 'client'
                                      CHECK (credit_wallet_owner IN ('client','agency')),
  -- Data residency: immutable after insert; moving = archive + recreate.
  region                  text        NOT NULL DEFAULT 'us-east-1',
  created_at              timestamptz NOT NULL DEFAULT now(),
  activated_at            timestamptz,
  paused_until            timestamptz,
  archived_at             timestamptz,
  CONSTRAINT sd_agency_not_own_client CHECK (agency_org_id IS NULL OR agency_org_id <> client_org_id)
);

-- Hot path: client portal (§53) — client sees all their deployments.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sd_client_status_created_idx
  ON public.solution_deployments (tenant_shard_id, client_org_id, status, created_at DESC);

-- Hot path: agency dashboard (§52) — agency sees all operated deployments.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sd_agency_status_created_idx
  ON public.solution_deployments (tenant_shard_id, agency_org_id, status, created_at DESC)
  WHERE agency_org_id IS NOT NULL;

-- Vendor aggregate stats — only active/pending rows; strips client identity.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sd_solution_status_active_idx
  ON public.solution_deployments (solution_id, status)
  WHERE status IN ('active','pending_setup');

-- Orphan cleanup cron query: find orphaned deployments older than 90 days.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sd_orphaned_created_idx
  ON public.solution_deployments (created_at)
  WHERE status = 'orphaned';

-- ---------------------------------------------------------------------------
-- 4. Trigger: prevent SaaS solutions from being deployed
--    CHECK can't reference another table directly; trigger enforces it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_deployment_solution_type()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  sol_type public.solution_type;
BEGIN
  SELECT solution_type INTO sol_type FROM public.solutions WHERE id = NEW.solution_id;
  IF sol_type = 'saas' THEN
    RAISE EXCEPTION 'SaaS solutions use the subscription flow, not deployments (solution_id=%)', NEW.solution_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sd_check_solution_type
  BEFORE INSERT ON public.solution_deployments
  FOR EACH ROW EXECUTE FUNCTION public.check_deployment_solution_type();

-- ---------------------------------------------------------------------------
-- 5. Trigger: require an active client_relationship when agency_org_id is set
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_deployment_relationship()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.agency_org_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_relationships
      WHERE agency_org_id = NEW.agency_org_id
        AND client_org_id = NEW.client_org_id
        AND status = 'active'
    ) THEN
      RAISE EXCEPTION
        'No active client_relationship between agency % and client % — invite/accept first',
        NEW.agency_org_id, NEW.client_org_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sd_check_relationship
  BEFORE INSERT ON public.solution_deployments
  FOR EACH ROW EXECUTE FUNCTION public.check_deployment_relationship();

-- ---------------------------------------------------------------------------
-- 6. Trigger: when a relationship ends, orphan the agency's deployments
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_relationship_end()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'ended' AND OLD.status <> 'ended' THEN
    UPDATE public.solution_deployments
    SET    status = 'orphaned'
    WHERE  agency_org_id  = NEW.agency_org_id
      AND  client_org_id  = NEW.client_org_id
      AND  status IN ('active','pending_setup','paused');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cr_orphan_on_end
  AFTER UPDATE ON public.client_relationships
  FOR EACH ROW EXECUTE FUNCTION public.on_relationship_end();

-- ---------------------------------------------------------------------------
-- 7. RLS — trust boundaries (NON-NEGOTIABLE)
-- ---------------------------------------------------------------------------
ALTER TABLE public.client_relationships ENABLE ROW LEVEL SECURITY;

-- Agency members see their own relationships.
CREATE POLICY cr_agency_read ON public.client_relationships
  FOR SELECT USING (agency_org_id = ANY(SELECT public.my_org_ids()));

-- Client org members see their own relationships.
CREATE POLICY cr_client_read ON public.client_relationships
  FOR SELECT USING (client_org_id = ANY(SELECT public.my_org_ids()));

-- Agency members can INSERT new relationships (creating invites).
CREATE POLICY cr_agency_insert ON public.client_relationships
  FOR INSERT WITH CHECK (agency_org_id = ANY(SELECT public.my_org_ids()));

-- Agency or client members can update their own relationship rows.
CREATE POLICY cr_update ON public.client_relationships
  FOR UPDATE
  USING (
    agency_org_id = ANY(SELECT public.my_org_ids())
    OR client_org_id = ANY(SELECT public.my_org_ids())
  )
  WITH CHECK (
    agency_org_id = ANY(SELECT public.my_org_ids())
    OR client_org_id = ANY(SELECT public.my_org_ids())
  );

-- Admins read everything.
CREATE POLICY cr_admin_read ON public.client_relationships
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ---------------------------------------------------------------------------

ALTER TABLE public.solution_deployments ENABLE ROW LEVEL SECURITY;

-- Client org members read their own deployments.
CREATE POLICY sd_client_read ON public.solution_deployments
  FOR SELECT USING (client_org_id = ANY(SELECT public.my_org_ids()));

-- Agency members read deployments they operate.
CREATE POLICY sd_agency_read ON public.solution_deployments
  FOR SELECT
  USING (agency_org_id IS NOT NULL AND agency_org_id = ANY(SELECT public.my_org_ids()));

-- Client org members can pause/archive (limited columns they control).
-- Full column enforcement is in the service layer; RLS just scopes rows.
CREATE POLICY sd_client_update ON public.solution_deployments
  FOR UPDATE USING (client_org_id = ANY(SELECT public.my_org_ids()));

-- Agency members can mutate runtime_config_override, branding, status.
CREATE POLICY sd_agency_update ON public.solution_deployments
  FOR UPDATE
  USING (agency_org_id IS NOT NULL AND agency_org_id = ANY(SELECT public.my_org_ids()));

-- INSERT is service-role only (createDeployment goes through admin client).
-- No authenticated INSERT policy — prevents direct row creation bypassing service layer.

-- Admins read/write everything.
CREATE POLICY sd_admin_all ON public.solution_deployments
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ---------------------------------------------------------------------------
-- 8. SECURITY DEFINER RPC: vendor aggregate stats (anti-poaching boundary)
--    Returns only aggregated counts — never client_org_id, agency_org_id,
--    branding, or runtime_config_override.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_vendor_deployment_stats(p_vendor_org_id uuid)
RETURNS TABLE (
  solution_id    uuid,
  solution_name  text,
  active_count   bigint,
  pending_count  bigint,
  paused_count   bigint,
  total_count    bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    s.id                                                              AS solution_id,
    s.name                                                            AS solution_name,
    COUNT(*) FILTER (WHERE sd.status = 'active')                     AS active_count,
    COUNT(*) FILTER (WHERE sd.status = 'pending_setup')              AS pending_count,
    COUNT(*) FILTER (WHERE sd.status = 'paused')                     AS paused_count,
    COUNT(sd.id)                                                      AS total_count
  FROM public.solutions s
  LEFT JOIN public.solution_deployments sd ON sd.solution_id = s.id
  WHERE s.org_id = p_vendor_org_id
    AND public.is_org_member(p_vendor_org_id)  -- caller must be in vendor org
  GROUP BY s.id, s.name;
$$;

-- ---------------------------------------------------------------------------
-- 9. Declare quotas for deployments + clients in org_quotas (already in #54 schema)
--    Ensure all existing orgs have quota rows (in case #54 seeded them).
--    The enforce.ts references active_deployments / clients on solution_deployments /
--    client_relationships with orgCol=agency_org_id — no change needed there.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 10. pg_cron: 90-day orphan auto-archive (runs at 04:00 UTC daily)
--     Orphaned deployments older than 90 days are archived; usage history kept.
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'archive-orphaned-deployments',
  '0 4 * * *',
  $$
    UPDATE public.solution_deployments
    SET    status = 'archived', archived_at = now()
    WHERE  status = 'orphaned'
      AND  created_at < now() - interval '90 days';
  $$
) WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron');
