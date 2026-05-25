-- =============================================================================
-- #49 — Solutions abstraction: apps → solutions rename + new columns + types
-- =============================================================================
-- Zero-downtime rename strategy:
--   1. ALTER TABLE apps RENAME TO solutions  (instant DDL, no rewrite)
--   2. All existing FKs/indexes/triggers follow the table automatically
--   3. CREATE VIEW apps AS SELECT * FROM solutions  (auto-updatable — INSERT/UPDATE/DELETE work)
--   4. All existing code referencing apps continues to work through the view
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Rename the table
-- ---------------------------------------------------------------------------
ALTER TABLE public.apps RENAME TO solutions;

-- Update the apps_updated_at trigger (still valid — trigger names follow table)
-- No action needed: trigger function set_updated_at is referenced by name and works on solutions

-- ---------------------------------------------------------------------------
-- 2. solution_type enum
-- ---------------------------------------------------------------------------
CREATE TYPE public.solution_type AS ENUM ('saas', 'agent', 'workflow', 'bundle');

-- ---------------------------------------------------------------------------
-- 3. New columns on solutions
-- ---------------------------------------------------------------------------
ALTER TABLE public.solutions
  ADD COLUMN IF NOT EXISTS solution_type    public.solution_type NOT NULL DEFAULT 'saas',
  ADD COLUMN IF NOT EXISTS runtime_config   jsonb,
  ADD COLUMN IF NOT EXISTS template_of_id   uuid REFERENCES public.solutions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN IF NOT EXISTS is_template      bool NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS solution_version text NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS tenant_shard_id  smallint NOT NULL DEFAULT 0;

-- Self-referential FK is deferrable so you can insert a template + fork in same txn.

-- Basic semver-ish format check (major.minor.patch, no pre-release for now)
ALTER TABLE public.solutions
  ADD CONSTRAINT sol_version_format
    CHECK (solution_version ~ '^\d+\.\d+\.\d+$');

-- ---------------------------------------------------------------------------
-- 4. New composite indexes (hot path for Wave 9 agency/marketplace queries)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS sol_org_status_type_idx
  ON public.solutions (org_id, status, solution_type, created_at DESC);

CREATE INDEX IF NOT EXISTS sol_active_type_idx
  ON public.solutions (status, solution_type, created_at DESC)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS sol_template_idx
  ON public.solutions (is_template, status)
  WHERE is_template = true;

CREATE INDEX IF NOT EXISTS sol_template_of_idx
  ON public.solutions (template_of_id)
  WHERE template_of_id IS NOT NULL;

-- Shard-aware composite for future regional routing
CREATE INDEX IF NOT EXISTS sol_shard_status_idx
  ON public.solutions (tenant_shard_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. solution_versions — history table capped at 50 versions per solution
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.solution_versions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id     uuid        NOT NULL REFERENCES public.solutions(id) ON DELETE CASCADE,
  version         text        NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  runtime_config  jsonb,
  changelog       text,
  published_at    timestamptz NOT NULL DEFAULT now(),
  published_by    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  tenant_shard_id smallint    NOT NULL DEFAULT 0,
  UNIQUE (solution_id, version)
);

CREATE INDEX IF NOT EXISTS sv_solution_published_idx
  ON public.solution_versions (solution_id, published_at DESC);

ALTER TABLE public.solution_versions ENABLE ROW LEVEL SECURITY;

-- Org members who own the solution can read its versions
CREATE POLICY sv_org_read ON public.solution_versions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.solutions s
      WHERE s.id = solution_id
        AND s.org_id = ANY(SELECT public.my_org_ids())
    )
  );

-- Service-role only writes (version snapshots are written by vendor actions via admin client)
CREATE POLICY sv_service_write ON public.solution_versions
  FOR ALL
  USING (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- 6. Trigger: cap solution_versions at 50 per solution (drop oldest by published_at)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cap_solution_versions()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.solution_versions
  WHERE solution_id = NEW.solution_id;

  IF v_count > 50 THEN
    DELETE FROM public.solution_versions
    WHERE id IN (
      SELECT id FROM public.solution_versions
      WHERE solution_id = NEW.solution_id
      ORDER BY published_at ASC
      LIMIT (v_count - 50)
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER cap_solution_versions_trigger
  AFTER INSERT ON public.solution_versions
  FOR EACH ROW EXECUTE FUNCTION public.cap_solution_versions();

-- ---------------------------------------------------------------------------
-- 7. Trigger: solution_type is immutable after first approval
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_solution_type_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.solution_type IS DISTINCT FROM NEW.solution_type
     AND OLD.status = 'approved'
  THEN
    RAISE EXCEPTION 'solution_type cannot be changed after solution is approved (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_solution_type
  BEFORE UPDATE ON public.solutions
  FOR EACH ROW EXECUTE FUNCTION public.guard_solution_type_change();

-- ---------------------------------------------------------------------------
-- 8. Trigger: bundles cannot nest other bundles (template_of_id allowed)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_bundle_nesting()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_parent_type public.solution_type;
BEGIN
  -- Only check when solution_type = 'bundle' and it references a template
  IF NEW.solution_type = 'bundle' AND NEW.template_of_id IS NOT NULL THEN
    SELECT solution_type INTO v_parent_type
    FROM public.solutions
    WHERE id = NEW.template_of_id;

    IF v_parent_type = 'bundle' THEN
      RAISE EXCEPTION 'bundles cannot nest other bundles (template_of_id=% is a bundle)', NEW.template_of_id;
    END IF;
  END IF;

  -- Also guard runtime bundle membership (future: items jsonb[] on bundle rows)
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_bundle_nesting
  BEFORE INSERT OR UPDATE ON public.solutions
  FOR EACH ROW EXECUTE FUNCTION public.guard_bundle_nesting();

-- ---------------------------------------------------------------------------
-- 9. Trigger: block semver downgrade (new version must be >= current)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_solution_version_downgrade()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_old int[];
  v_new int[];
BEGIN
  IF OLD.solution_version IS DISTINCT FROM NEW.solution_version THEN
    -- Parse semver into integer arrays for comparison
    v_old := ARRAY(
      SELECT unnest(string_to_array(OLD.solution_version, '.'))::int
    );
    v_new := ARRAY(
      SELECT unnest(string_to_array(NEW.solution_version, '.'))::int
    );

    -- Compare major, then minor, then patch
    IF (v_new[1], v_new[2], v_new[3]) < (v_old[1], v_old[2], v_old[3]) THEN
      RAISE EXCEPTION 'solution_version cannot be downgraded from % to %',
        OLD.solution_version, NEW.solution_version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_solution_version_downgrade
  BEFORE UPDATE ON public.solutions
  FOR EACH ROW EXECUTE FUNCTION public.guard_solution_version_downgrade();

-- ---------------------------------------------------------------------------
-- 10. Legacy apps VIEW — auto-updatable, backward compat for existing code
-- ---------------------------------------------------------------------------
-- Simple SELECT * view is auto-updatable in Postgres:
--   INSERT/UPDATE/DELETE on apps pass through to solutions transparently.
-- Drop this view in #21 (docs-sync) after auditing all callsites.
CREATE OR REPLACE VIEW public.apps WITH (security_invoker = true) AS
  SELECT * FROM public.solutions;

-- Grant same privileges as the table had (RLS on solutions covers security)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.apps TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.apps TO service_role;

-- ---------------------------------------------------------------------------
-- 11. Update RLS policies (they followed the rename; no action needed)
-- ---------------------------------------------------------------------------
-- The existing RLS policies are now on public.solutions (name unchanged).
-- org_id-based policies via is_org_member() continue to work as-is.

-- ---------------------------------------------------------------------------
-- 12. Update FTS index comment (the index apps_fts_idx is now on solutions)
-- ---------------------------------------------------------------------------
COMMENT ON INDEX public.apps_fts_idx IS
  'GIN FTS index on solutions(name, description) — was apps_fts_idx, now on solutions table';

-- ---------------------------------------------------------------------------
-- 13. Feature-flag guard: non-SaaS solution types are gated
-- ---------------------------------------------------------------------------
-- The guard lives in application code (SOLUTIONS_NON_SAAS_ENABLED env flag).
-- At DB level, all types are valid; the app-layer check prevents accidental
-- non-SaaS creation before the feature is ready.
COMMENT ON TYPE public.solution_type IS
  'saas: always enabled; agent/workflow/bundle: gated by SOLUTIONS_NON_SAAS_ENABLED';

-- ---------------------------------------------------------------------------
-- 14. Update list_marketplace_apps RPC to SELECT FROM solutions
-- ---------------------------------------------------------------------------
-- The existing RPC already queries `public.apps` which now resolves through
-- the VIEW → solutions. No RPC rewrite needed — the view is transparent.
-- The FTS index and other indexes on solutions are used by the planner.

-- ---------------------------------------------------------------------------
-- 15. Add solution_type to the list_marketplace_apps RPC output
-- ---------------------------------------------------------------------------
-- Update the RPC to expose solution_type so frontend can display type badges.
DROP FUNCTION IF EXISTS public.list_marketplace_apps(text, text, integer, integer);
CREATE OR REPLACE FUNCTION public.list_marketplace_apps(
  p_page        int DEFAULT 1,
  p_page_size   int DEFAULT 24,
  p_category    text DEFAULT NULL,
  p_search      text DEFAULT NULL,
  p_sort        text DEFAULT 'trending',
  p_price_min   bigint DEFAULT NULL,
  p_price_max   bigint DEFAULT NULL,
  p_rating_min  numeric DEFAULT NULL,
  p_has_affiliate bool DEFAULT NULL,
  p_has_trial   bool DEFAULT NULL,
  p_solution_type text DEFAULT NULL
)
RETURNS TABLE (
  id                       uuid,
  name                     text,
  description              text,
  category                 text,
  price_cents              bigint,
  currency                 text,
  vendor_name              text,
  screenshot_urls          text[],
  rating_avg               numeric,
  rating_count             int,
  affiliate_commission_bps smallint,
  has_free_trial           bool,
  subscriber_count         bigint,
  solution_type            public.solution_type,
  is_template              bool,
  total_count              bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_offset int := (p_page - 1) * p_page_size;
  v_fts    tsquery;
BEGIN
  IF p_search IS NOT NULL AND length(trim(p_search)) > 0 THEN
    v_fts := plainto_tsquery('english', p_search);
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      a.id,
      a.name,
      a.description,
      a.category,
      a.price_cents,
      a.currency,
      p.full_name                        AS vendor_name,
      a.screenshot_urls,
      a.rating_avg,
      a.rating_count::int,
      a.affiliate_commission_bps,
      a.has_free_trial,
      a.solution_type,
      a.is_template,
      (
        SELECT COUNT(*) FROM public.subscriptions s
        WHERE s.app_id = a.id AND s.status = 'active'
      )::bigint                          AS subscriber_count,
      CASE WHEN v_fts IS NOT NULL
        THEN ts_rank(to_tsvector('english', a.name || ' ' || COALESCE(a.description, '')), v_fts)
        ELSE 0
      END                                AS rank,
      a.created_at,
      a.featured_until
    FROM   public.solutions a
    JOIN   public.profiles  p ON p.id = a.vendor_id
    WHERE  a.status = 'approved'
      AND (p_category    IS NULL OR a.category = p_category)
      AND (p_price_min   IS NULL OR a.price_cents >= p_price_min)
      AND (p_price_max   IS NULL OR a.price_cents <= p_price_max)
      AND (p_rating_min  IS NULL OR a.rating_avg  >= p_rating_min)
      AND (p_has_affiliate IS NULL OR (p_has_affiliate AND a.affiliate_commission_bps IS NOT NULL)
                                   OR (NOT p_has_affiliate AND a.affiliate_commission_bps IS NULL))
      AND (p_has_trial   IS NULL OR a.has_free_trial = p_has_trial)
      AND (p_solution_type IS NULL OR a.solution_type::text = p_solution_type)
      AND (v_fts         IS NULL OR to_tsvector('english', a.name || ' ' || COALESCE(a.description, '')) @@ v_fts)
  ),
  counted AS (
    SELECT *, COUNT(*) OVER () AS total_count FROM base
  )
  SELECT
    c.id,
    c.name,
    c.description,
    c.category,
    c.price_cents,
    c.currency,
    c.vendor_name,
    c.screenshot_urls,
    c.rating_avg,
    c.rating_count,
    c.affiliate_commission_bps,
    c.has_free_trial,
    c.subscriber_count,
    c.solution_type,
    c.is_template,
    c.total_count
  FROM counted c
  ORDER BY
    CASE p_sort
      WHEN 'trending'    THEN c.subscriber_count * -1
      WHEN 'newest'      THEN EXTRACT(EPOCH FROM c.created_at) * -1
      WHEN 'price_asc'   THEN c.price_cents::float
      WHEN 'price_desc'  THEN c.price_cents::float * -1
      WHEN 'rating'      THEN c.rating_avg * -1
      WHEN 'relevance'   THEN c.rank * -1
      ELSE c.subscriber_count * -1
    END,
    c.id
  LIMIT  p_page_size
  OFFSET v_offset;
END;
$$;

-- ---------------------------------------------------------------------------
-- 16. get_featured_apps: select from solutions directly
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_featured_apps(integer);
CREATE OR REPLACE FUNCTION public.get_featured_apps(p_limit int DEFAULT 5)
RETURNS TABLE (
  id              uuid,
  name            text,
  description     text,
  category        text,
  price_cents     bigint,
  currency        text,
  vendor_name     text,
  screenshot_urls text[],
  rating_avg      numeric,
  rating_count    int,
  solution_type   public.solution_type
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.id,
    a.name,
    a.description,
    a.category,
    a.price_cents,
    a.currency,
    p.full_name AS vendor_name,
    a.screenshot_urls,
    a.rating_avg,
    a.rating_count::int,
    a.solution_type
  FROM   public.solutions a
  JOIN   public.profiles  p ON p.id = a.vendor_id
  WHERE  a.status = 'approved'
    AND  a.featured_until > now()
  ORDER BY a.featured_until DESC
  LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- 17. get_marketplace_app: add solution_type + runtime_config to detail view
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_marketplace_app(uuid);
CREATE OR REPLACE FUNCTION public.get_marketplace_app(p_id uuid)
RETURNS TABLE (
  id                       uuid,
  name                     text,
  description              text,
  category                 text,
  price_cents              bigint,
  currency                 text,
  auth_url                 text,
  vendor_name              text,
  screenshot_urls          text[],
  rating_avg               numeric,
  rating_count             int,
  affiliate_commission_bps smallint,
  has_free_trial           bool,
  solution_type            public.solution_type,
  is_template              bool,
  solution_version         text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.id,
    a.name,
    a.description,
    a.category,
    a.price_cents,
    a.currency,
    a.auth_url,
    p.full_name AS vendor_name,
    a.screenshot_urls,
    a.rating_avg,
    a.rating_count::int,
    a.affiliate_commission_bps,
    a.has_free_trial,
    a.solution_type,
    a.is_template,
    a.solution_version
  FROM   public.solutions a
  JOIN   public.profiles  p ON p.id = a.vendor_id
  WHERE  a.id     = p_id
    AND  a.status = 'approved';
END;
$$;
