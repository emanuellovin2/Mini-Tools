-- =============================================================================
-- #30 — App screenshots gallery
-- =============================================================================

-- (A) Storage bucket for app screenshots (public reads, vendor-prefixed writes)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'app-screenshots',
  'app-screenshots',
  true,
  1048576,
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "app_screenshots_public_select" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'app-screenshots');

CREATE POLICY "app_screenshots_vendor_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'app-screenshots'
    AND (storage.foldername(name))[1] = (auth.uid())::text
    AND (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'vendor'
  );

CREATE POLICY "app_screenshots_vendor_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'app-screenshots'
    AND (storage.foldername(name))[1] = (auth.uid())::text
    AND (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'vendor'
  );

-- (B) Add screenshot_urls to apps table
ALTER TABLE public.apps
  ADD COLUMN screenshot_urls text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.apps.screenshot_urls IS
  'Ordered list of public screenshot URLs (3–7 images). First element is the marketplace preview / hero. Empty array allowed for pending/draft apps; approved apps must have 3–7.';

-- Backfill existing approved apps before adding the constraint
UPDATE public.apps
SET screenshot_urls = ARRAY[
  'https://placehold.co/1280x800/f3f4f6/6b7280?text=Screenshot+1',
  'https://placehold.co/1280x800/f3f4f6/6b7280?text=Screenshot+2',
  'https://placehold.co/1280x800/f3f4f6/6b7280?text=Screenshot+3'
]
WHERE status = 'approved' AND cardinality(screenshot_urls) < 3;

-- 0 (pending) or 3–7
ALTER TABLE public.apps
  ADD CONSTRAINT apps_screenshot_count CHECK (
    cardinality(screenshot_urls) = 0
    OR (cardinality(screenshot_urls) >= 3 AND cardinality(screenshot_urls) <= 7)
  );

-- Approved apps must have at least 3 screenshots
ALTER TABLE public.apps
  ADD CONSTRAINT apps_approved_has_screenshots CHECK (
    status != 'approved' OR cardinality(screenshot_urls) >= 3
  );

-- (C) Update list_marketplace_apps RPC to include screenshots
CREATE OR REPLACE FUNCTION public.list_marketplace_apps(
  p_search    text    DEFAULT NULL,
  p_category  text    DEFAULT NULL,
  p_page      int     DEFAULT 1,
  p_page_size int     DEFAULT 12
)
RETURNS TABLE (
  id              uuid,
  name            text,
  description     text,
  category        text,
  price_cents     bigint,
  currency        text,
  vendor_name     text,
  screenshot_urls text[],
  total_count     bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id,
    a.name,
    a.description,
    a.category,
    a.price_cents,
    a.currency,
    p.display_name     AS vendor_name,
    a.screenshot_urls,
    COUNT(*) OVER ()   AS total_count
  FROM   apps     a
  JOIN   profiles p ON p.id = a.vendor_id
  WHERE  a.status = 'approved'
    AND  p.charges_enabled = true
    AND  (p_category IS NULL OR a.category = p_category)
    AND  (
      p_search IS NULL
      OR a.name        ILIKE '%' || p_search || '%'
      OR a.description ILIKE '%' || p_search || '%'
    )
  ORDER BY a.created_at DESC
  LIMIT  p_page_size
  OFFSET ((p_page - 1) * p_page_size);
$$;

-- (D) Update get_marketplace_app RPC to include screenshots
CREATE OR REPLACE FUNCTION public.get_marketplace_app(p_id uuid)
RETURNS TABLE (
  id              uuid,
  name            text,
  description     text,
  category        text,
  price_cents     bigint,
  currency        text,
  auth_url        text,
  vendor_name     text,
  screenshot_urls text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id,
    a.name,
    a.description,
    a.category,
    a.price_cents,
    a.currency,
    a.auth_url,
    p.display_name   AS vendor_name,
    a.screenshot_urls
  FROM   apps     a
  JOIN   profiles p ON p.id = a.vendor_id
  WHERE  a.id     = p_id
    AND  a.status = 'approved'
    AND  p.charges_enabled = true;
$$;
