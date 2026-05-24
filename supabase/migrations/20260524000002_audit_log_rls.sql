-- Harden audit_log: RLS on, admin-read-only, no UPDATE/DELETE for anyone but service-role.
-- audit_log rows are immutable once written — a tampered audit log is worthless.

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_admin_read ON public.audit_log;
CREATE POLICY audit_log_admin_read ON public.audit_log
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- No INSERT policy for authenticated users — all inserts go through service-role (admin client).
-- No UPDATE/DELETE policy — omitting them denies those operations for all authenticated users.
-- service_role bypasses RLS entirely and can still write rows.
