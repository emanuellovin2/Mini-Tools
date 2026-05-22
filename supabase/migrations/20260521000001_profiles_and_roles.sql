-- Roles enum
CREATE TYPE public.user_role AS ENUM ('admin', 'vendor', 'buyer', 'reseller');

-- Profiles table (mirrors auth.users)
CREATE TABLE public.profiles (
  id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role         public.user_role NOT NULL DEFAULT 'buyer',
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-create profile on auth.users insert
-- Role defaults to 'buyer'; sign-up flow passes intended_role via metadata
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  intended text;
  resolved_role public.user_role;
BEGIN
  intended := NEW.raw_user_meta_data->>'intended_role';
  IF intended = 'vendor' THEN
    resolved_role := 'vendor';
  ELSE
    resolved_role := 'buyer';
  END IF;

  INSERT INTO public.profiles (id, role)
  VALUES (NEW.id, resolved_role);

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

-- Users can update their own profile BUT cannot change their role
-- (role + stripe columns are service-role-only writes)
CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND role = (SELECT role FROM public.profiles WHERE id = auth.uid())
  );

-- Service role can do anything (bypasses RLS automatically)
-- No explicit INSERT policy needed — new rows are created by the trigger (SECURITY DEFINER)

-- Index
CREATE INDEX profiles_role_idx ON public.profiles (role);
