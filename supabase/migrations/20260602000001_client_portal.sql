-- #53 Client portal
-- Adds portal_branding to agency orgs + RLS for client org reads.

-- Agency portal branding (logo_url, brand_color, display_name)
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS portal_branding jsonb;

-- Allow client org members to read their own org row (needed for portal layout)
-- Uses the existing is_org_member() STABLE SECURITY DEFINER function from #47.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'organizations' AND policyname = 'client_read_own_org'
  ) THEN
    CREATE POLICY client_read_own_org ON public.organizations
      FOR SELECT
      USING (is_org_member(id));
  END IF;
END $$;

-- Allow client org members to read their active agency relationship
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'client_relationships' AND policyname = 'client_read_own_relationship'
  ) THEN
    CREATE POLICY client_read_own_relationship ON public.client_relationships
      FOR SELECT
      USING (
        is_org_member(client_org_id)
        OR is_org_member(agency_org_id)
      );
  END IF;
END $$;
