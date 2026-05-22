-- Migration #8: track when a vendor first successfully verifies a token
-- from their app's auth_url — serves as "Integration connected" signal.
ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS first_verified_at timestamptz;
