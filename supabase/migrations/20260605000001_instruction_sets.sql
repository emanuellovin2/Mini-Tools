-- #56 Hierarchical instruction sets + prompt versioning
-- Adds: instruction_sets, instruction_versions (immutable snapshots),
-- 50-version cap trigger, org_quotas column, RLS policies,
-- backfill from gateway_products.system_prompt.

-- ---------------------------------------------------------------------------
-- 1. instruction_sets — editable head per scope
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instruction_sets (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_level      text        NOT NULL,            -- 'global' | 'project' | 'client' | 'deployment'
  scope_ref_id     uuid,                            -- NULL for global; project_id / client_org_id / deployment_id
  name             text        NOT NULL,
  active_version_id uuid,                           -- FK set after first publish; nullable until then
  status           text        NOT NULL DEFAULT 'draft',  -- draft | published
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instruction_sets_scope_level_check
    CHECK (scope_level IN ('global','project','client','deployment')),
  CONSTRAINT instruction_sets_status_check
    CHECK (status IN ('draft','published')),
  CONSTRAINT instruction_sets_scope_uniq UNIQUE (org_id, scope_level, scope_ref_id)
);

CREATE INDEX IF NOT EXISTS instruction_sets_org_idx
  ON public.instruction_sets (org_id);

CREATE INDEX IF NOT EXISTS instruction_sets_scope_ref_idx
  ON public.instruction_sets (scope_ref_id)
  WHERE scope_ref_id IS NOT NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_instruction_sets_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'instruction_sets_updated_at_trigger'
      AND tgrelid = 'public.instruction_sets'::regclass
  ) THEN
    CREATE TRIGGER instruction_sets_updated_at_trigger
      BEFORE UPDATE ON public.instruction_sets
      FOR EACH ROW EXECUTE FUNCTION public.set_instruction_sets_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. instruction_versions — immutable snapshots (Git-like)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instruction_versions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_set_id uuid        NOT NULL REFERENCES public.instruction_sets(id) ON DELETE CASCADE,
  version            int         NOT NULL CHECK (version > 0),
  blocks             jsonb       NOT NULL DEFAULT '[]',
  variables          jsonb       NOT NULL DEFAULT '{}',
  content_hash       text        NOT NULL,
  created_by         uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instruction_versions_set_version_uniq UNIQUE (instruction_set_id, version)
);

CREATE INDEX IF NOT EXISTS instruction_versions_set_idx
  ON public.instruction_versions (instruction_set_id);

-- FK from instruction_sets.active_version_id → instruction_versions(id)
-- Added after table creation to avoid circular dependency
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'instruction_sets_active_version_fk'
      AND table_name = 'instruction_sets'
  ) THEN
    ALTER TABLE public.instruction_sets
      ADD CONSTRAINT instruction_sets_active_version_fk
      FOREIGN KEY (active_version_id) REFERENCES public.instruction_versions(id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. 50-version cap trigger (same discipline as workflow_versions)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cap_instruction_versions()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.instruction_versions
  WHERE instruction_set_id = NEW.instruction_set_id;

  IF v_count >= 50 THEN
    -- Delete the oldest version that is NOT the active one
    DELETE FROM public.instruction_versions
    WHERE id = (
      SELECT iv.id FROM public.instruction_versions iv
      LEFT JOIN public.instruction_sets ins ON ins.active_version_id = iv.id
      WHERE iv.instruction_set_id = NEW.instruction_set_id
        AND ins.id IS NULL  -- not active
      ORDER BY iv.version ASC
      LIMIT 1
    );
  END IF;

  RETURN NEW;
END; $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'cap_instruction_versions_trigger'
      AND tgrelid = 'public.instruction_versions'::regclass
  ) THEN
    CREATE TRIGGER cap_instruction_versions_trigger
      BEFORE INSERT ON public.instruction_versions
      FOR EACH ROW EXECUTE FUNCTION public.cap_instruction_versions();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.instruction_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instruction_versions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- instruction_sets: org members + special visibility for client/deployment scopes
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'instruction_sets' AND policyname = 'instruction_sets_rls'
  ) THEN
    CREATE POLICY instruction_sets_rls ON public.instruction_sets
      FOR ALL
      USING (is_org_member(org_id));
  END IF;

  -- instruction_versions: accessible if the parent instruction_set is accessible
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'instruction_versions' AND policyname = 'instruction_versions_rls'
  ) THEN
    CREATE POLICY instruction_versions_rls ON public.instruction_versions
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM public.instruction_sets ins
          WHERE ins.id = instruction_versions.instruction_set_id
            AND is_org_member(ins.org_id)
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. org_quotas — add instruction_sets column (migration-safe: ADD COLUMN with DEFAULT)
-- ---------------------------------------------------------------------------
ALTER TABLE public.org_quotas
  ADD COLUMN IF NOT EXISTS max_instruction_sets int NOT NULL DEFAULT 200;

-- ---------------------------------------------------------------------------
-- 6. Backfill: gateway_products.system_prompt → global instruction sets
--    One global set per org that has any gateway_product with non-null system_prompt.
--    Existing products continue to work identically (behavior-preserving).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  rec RECORD;
  v_set_id uuid;
  v_version_id uuid;
  v_blocks jsonb;
  v_hash text;
BEGIN
  -- For each solution that has a gateway_product with a non-null system_prompt,
  -- find (or create) the org's global instruction set and seed it.
  FOR rec IN
    SELECT DISTINCT ON (s.org_id)
      s.org_id,
      gp.system_prompt,
      gp.id AS product_id
    FROM public.gateway_products gp
    JOIN public.solutions s ON s.id = gp.solution_id
    WHERE gp.system_prompt IS NOT NULL AND gp.system_prompt <> ''
    ORDER BY s.org_id, gp.created_at ASC
  LOOP
    -- Check if a global set already exists for this org
    SELECT id INTO v_set_id
    FROM public.instruction_sets
    WHERE org_id = rec.org_id
      AND scope_level = 'global'
      AND scope_ref_id IS NULL;

    IF v_set_id IS NULL THEN
      v_blocks := jsonb_build_array(
        jsonb_build_object(
          'key', 'system',
          'mode', 'replace',
          'text', rec.system_prompt
        )
      );
      v_hash := encode(sha256(v_blocks::text::bytea), 'hex');

      INSERT INTO public.instruction_sets (org_id, scope_level, name, status)
      VALUES (rec.org_id, 'global', 'Default system prompt', 'published')
      RETURNING id INTO v_set_id;

      INSERT INTO public.instruction_versions
        (instruction_set_id, version, blocks, content_hash, created_by)
      VALUES
        (v_set_id, 1, v_blocks, v_hash, rec.org_id)
      RETURNING id INTO v_version_id;

      UPDATE public.instruction_sets
      SET active_version_id = v_version_id
      WHERE id = v_set_id;
    END IF;
  END LOOP;
END $$;
