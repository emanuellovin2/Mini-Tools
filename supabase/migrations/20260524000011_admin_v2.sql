-- Admin v2: feature_flags table for incident-response kill switches

CREATE TABLE public.feature_flags (
  name        text PRIMARY KEY,
  enabled     boolean      NOT NULL DEFAULT true,
  description text,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

INSERT INTO public.feature_flags (name, enabled, description) VALUES
  ('wl_tier2_signup',       true, 'Allow resellers to start Tier 2 WL upgrades'),
  ('affiliate_signup',      true, 'Allow new affiliate applications'),
  ('reseller_signup',       true, 'Allow new reseller subscriptions ($19/mo)'),
  ('new_app_submissions',   true, 'Allow vendors to submit new apps for approval'),
  ('payouts',               true, 'Enable Stripe Connect payout transfers to connected accounts')
ON CONFLICT DO NOTHING;

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read flags (proxy/server-side checks gate features)
CREATE POLICY "read_feature_flags"
  ON public.feature_flags FOR SELECT
  USING (true);

-- Only admins can mutate
CREATE POLICY "admin_write_feature_flags"
  ON public.feature_flags FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );
