-- Per-vendor manual cut override for direct sales.
-- NULL = use auto-tier from vendor_billing (unchanged behaviour).
-- Range: 0 bps (0% — platform takes nothing) to 5000 bps (50% — sanity cap; anything
-- higher is almost certainly a data-entry error: e.g. 7000 instead of 700 for 7%).
--
-- IMPORTANT: this column is intentionally NOT written by the monthly billing cron.
-- vendor_billing.cut_bps always reflects the tier model (historical record stays clean).
-- Only live transfers (getVendorCutBps) and the vendor dashboard "effective cut" read this.
-- Order of precedence: override → vendor_billing.cut_bps → 1200 default (Tier 1, SPEC §8).
ALTER TABLE public.profiles
  ADD COLUMN vendor_cut_bps_override smallint
    CHECK (vendor_cut_bps_override IS NULL OR vendor_cut_bps_override BETWEEN 0 AND 5000);

COMMENT ON COLUMN public.profiles.vendor_cut_bps_override IS
  'Manual platform cut override for direct sales (bps). NULL = use auto-tier from vendor_billing. Admin-set only; write attempts by non-admins are rejected by guard_vendor_cut_override_trigger. Every change produces an audit_log entry with action=vendor_cut_override_set.';

-- ── Guard trigger ─────────────────────────────────────────────────────────────
-- Prevents any non-admin (including a vendor updating their own profile) from
-- mutating this column via the Supabase REST API (anon or user JWT).
-- The service-role client used by server actions bypasses RLS but still fires
-- row-level triggers, so this is an extra hard stop.
CREATE OR REPLACE FUNCTION public.guard_vendor_cut_override()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.vendor_cut_bps_override IS DISTINCT FROM OLD.vendor_cut_bps_override THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    ) THEN
      RAISE EXCEPTION 'vendor_cut_bps_override can only be modified by admin';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guard_vendor_cut_override_trigger
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (OLD.vendor_cut_bps_override IS DISTINCT FROM NEW.vendor_cut_bps_override)
  EXECUTE FUNCTION public.guard_vendor_cut_override();

-- ── Atomic set + audit RPC ────────────────────────────────────────────────────
-- Called by setVendorCutOverride() in lib/services/admin.ts via service-role client.
-- The trigger above won't fire for service-role (no auth.uid()), so the RPC re-checks
-- p_admin_id's role as a belt-and-suspenders guard.
CREATE OR REPLACE FUNCTION public.admin_set_vendor_cut_override(
  p_admin_id  uuid,
  p_vendor_id uuid,
  p_new_bps   smallint,   -- NULL to clear
  p_reason    text,
  p_old_bps   smallint    -- NULL if no prior override
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role = 'admin') THEN
    RAISE EXCEPTION 'caller is not admin';
  END IF;

  UPDATE public.profiles
    SET vendor_cut_bps_override = p_new_bps,
        updated_at = now()
    WHERE id = p_vendor_id AND role = 'vendor';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor % not found', p_vendor_id;
  END IF;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity_type, entity_id, metadata)
  VALUES (
    p_admin_id,
    'admin',
    'vendor_cut_override_set',
    'profile',
    p_vendor_id::text,
    jsonb_build_object('old_bps', p_old_bps, 'new_bps', p_new_bps, 'reason', p_reason)
  );
END $$;

-- ── Read helper for admin dashboard ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_get_vendors_cut_info()
RETURNS TABLE (
  vendor_id        uuid,
  display_name     text,
  cut_bps_override smallint,
  auto_tier_cut_bps  int,
  effective_cut_bps  int
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT
    p.id,
    p.display_name,
    p.vendor_cut_bps_override,
    COALESCE(
      (SELECT cut_bps FROM public.vendor_billing
       WHERE vendor_id = p.id AND period_start <= current_date
       ORDER BY period_start DESC LIMIT 1),
      1200
    ) AS auto_tier_cut_bps,
    COALESCE(
      p.vendor_cut_bps_override::int,
      (SELECT cut_bps FROM public.vendor_billing
       WHERE vendor_id = p.id AND period_start <= current_date
       ORDER BY period_start DESC LIMIT 1),
      1200
    ) AS effective_cut_bps
  FROM public.profiles p
  WHERE p.role = 'vendor'
  ORDER BY p.display_name NULLS LAST;
$$;

-- Lock down: only service_role may call these RPCs.
REVOKE EXECUTE ON FUNCTION public.admin_set_vendor_cut_override FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_get_vendors_cut_info    FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_set_vendor_cut_override TO service_role;
GRANT  EXECUTE ON FUNCTION public.admin_get_vendors_cut_info    TO service_role;
