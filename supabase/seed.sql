-- ============================================================
-- Seed data for local development and testing
-- Password for all test users: password123
-- ============================================================

-- pgcrypto is needed for crypt() / gen_salt()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  admin_id  uuid := '00000000-0000-0000-0000-000000000001';
  vendor_a  uuid := '00000000-0000-0000-0000-000000000002';  -- charges_enabled=true
  vendor_b  uuid := '00000000-0000-0000-0000-000000000003';  -- charges_enabled=false
  buyer_1   uuid := '00000000-0000-0000-0000-000000000004';
  buyer_2   uuid := '00000000-0000-0000-0000-000000000005';  -- canceled + resubscribed
  buyer_3   uuid := '00000000-0000-0000-0000-000000000006';  -- canceled (churn data)
BEGIN
  -- Insert auth users; the handle_new_user trigger auto-creates profiles.
  -- GoTrue v2.188+ scans confirmation_token / recovery_token / email_change_token_new
  -- as non-nullable Go strings, so they must be '' not NULL.
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    is_super_admin, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
    (admin_id, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'admin@test.com',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}', '{}',
     false, now(), now(), '', '', '', ''),

    (vendor_a, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'vendor-a@test.com',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}', '{"intended_role":"vendor"}',
     false, now(), now(), '', '', '', ''),

    (vendor_b, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'vendor-b@test.com',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}', '{"intended_role":"vendor"}',
     false, now(), now(), '', '', '', ''),

    (buyer_1, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'buyer-1@test.com',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}', '{}',
     false, now(), now(), '', '', '', ''),

    (buyer_2, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'buyer-2@test.com',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}', '{}',
     false, now(), now(), '', '', '', ''),

    (buyer_3, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'buyer-3@test.com',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}', '{}',
     false, now(), now(), '', '', '', '')
  ON CONFLICT (id) DO NOTHING;

  -- Update profiles (seed runs as postgres, bypasses RLS)
  UPDATE public.profiles
  SET role = 'admin', display_name = 'Platform Admin'
  WHERE id = admin_id;

  UPDATE public.profiles
  SET display_name = 'Vendor Alpha',
      charges_enabled = true,
      payouts_enabled = true,
      stripe_account_id = 'acct_test_vendor_alpha'
  WHERE id = vendor_a;

  UPDATE public.profiles
  SET display_name = 'Vendor Beta',
      charges_enabled = false,
      payouts_enabled = false
  WHERE id = vendor_b;

  UPDATE public.profiles SET display_name = 'Buyer One'   WHERE id = buyer_1;
  UPDATE public.profiles SET display_name = 'Buyer Two'   WHERE id = buyer_2;
  UPDATE public.profiles SET display_name = 'Buyer Three' WHERE id = buyer_3;
END $$;

-- ============================================================
-- Apps
-- vendor_a: approved (resellable), pending, rejected
-- vendor_b: approved but charges_enabled=false (should not appear in public listing)
-- ============================================================

INSERT INTO public.apps (
  id, vendor_id, name, description, category,
  price_cents, min_price_cents, auth_url, status
) VALUES
  ('00000000-0000-0000-0001-000000000001',
   '00000000-0000-0000-0000-000000000002',
   'AI Writer Pro', 'AI-powered writing assistant', 'writing',
   2900, 2000,
   'https://aiwriter.example.com/auth', 'approved'),

  ('00000000-0000-0000-0001-000000000002',
   '00000000-0000-0000-0000-000000000002',
   'DataViz Tool', 'Data visualisation SaaS', 'analytics',
   4900, NULL,
   'https://dataviz.example.com/auth', 'pending'),

  ('00000000-0000-0000-0001-000000000003',
   '00000000-0000-0000-0000-000000000002',
   'Old App', 'Rejected legacy app', 'misc',
   1900, NULL,
   'https://oldapp.example.com/auth', 'rejected'),

  ('00000000-0000-0000-0001-000000000004',
   '00000000-0000-0000-0000-000000000003',
   'Beta Tool', 'App by vendor B (not charges-enabled)', 'tools',
   3900, NULL,
   'https://betatool.example.com/auth', 'approved');

-- ============================================================
-- Subscriptions
--   buyer_1  → app_1 (active)
--   buyer_2  → app_1 (canceled 3 months ago) then app_1 (active, resubscribed)
--             Both rows share the SAME anon_user_id (SPEC §6)
--   buyer_3  → app_1 (canceled last month, for churn stats in #10)
-- ============================================================

INSERT INTO public.subscriptions (
  id, buyer_id, app_id,
  stripe_subscription_id, stripe_customer_id,
  status, price_cents, anon_user_id,
  cancel_at_period_end, current_period_end, canceled_at,
  created_at
) VALUES
  -- buyer_1: active
  ('00000000-0000-0000-0002-000000000001',
   '00000000-0000-0000-0000-000000000004',
   '00000000-0000-0000-0001-000000000001',
   'sub_test_buyer1_active', 'cus_test_buyer1',
   'active', 2900, 'usr_b1a1anon001',
   false, now() + interval '30 days', NULL,
   now() - interval '20 days'),

  -- buyer_2: CANCELED 3 months ago (snapshot for anon_user_id reuse test)
  ('00000000-0000-0000-0002-000000000002',
   '00000000-0000-0000-0000-000000000005',
   '00000000-0000-0000-0001-000000000001',
   'sub_test_buyer2_canceled', 'cus_test_buyer2',
   'canceled', 2900, 'usr_b2a1anon002',
   false, now() - interval '60 days', now() - interval '60 days',
   now() - interval '90 days'),

  -- buyer_2: ACTIVE resubscription — same anon_user_id as the canceled row above
  ('00000000-0000-0000-0002-000000000003',
   '00000000-0000-0000-0000-000000000005',
   '00000000-0000-0000-0001-000000000001',
   'sub_test_buyer2_resub', 'cus_test_buyer2',
   'active', 2900, 'usr_b2a1anon002',
   false, now() + interval '30 days', NULL,
   now() - interval '5 days'),

  -- buyer_3: CANCELED last month (for churn detection in #10)
  ('00000000-0000-0000-0002-000000000004',
   '00000000-0000-0000-0000-000000000006',
   '00000000-0000-0000-0001-000000000001',
   'sub_test_buyer3_canceled', 'cus_test_buyer3',
   'canceled', 2900, 'usr_b3a1anon003',
   false, now() - interval '5 days', now() - interval '5 days',
   now() - interval '35 days');

-- ============================================================
-- vendor_billing history for vendor_a
-- ============================================================

INSERT INTO public.vendor_billing (
  vendor_id, period_start, period_end,
  gross_revenue_cents, tier, cut_bps, computed_at
) VALUES
  ('00000000-0000-0000-0000-000000000002',
   '2026-03-01', '2026-03-31', 85000, 1, 2000, '2026-04-01 00:05:00+00'),

  ('00000000-0000-0000-0000-000000000002',
   '2026-04-01', '2026-04-30', 120000, 2, 1000, '2026-05-01 00:05:00+00');
