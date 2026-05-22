-- ============================================================
-- Migration #4: Marketplace RPC functions
-- SECURITY DEFINER so the join to profiles bypasses RLS while
-- still enforcing the charges_enabled=true / status=approved filters.
-- ============================================================

-- Paginated marketplace listing with optional search and category filter.
-- Returns total_count as a window function so callers need only one query.
CREATE OR REPLACE FUNCTION public.list_marketplace_apps(
  p_search    text    DEFAULT NULL,
  p_category  text    DEFAULT NULL,
  p_page      int     DEFAULT 1,
  p_page_size int     DEFAULT 12
)
RETURNS TABLE (
  id          uuid,
  name        text,
  description text,
  category    text,
  price_cents bigint,
  currency    text,
  vendor_name text,
  total_count bigint
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
    p.display_name   AS vendor_name,
    COUNT(*) OVER () AS total_count
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

-- Fetch a single app for the detail page.
-- Returns empty if the app doesn't exist, isn't approved, or the vendor
-- can't receive funds — the caller must treat empty as 404.
CREATE OR REPLACE FUNCTION public.get_marketplace_app(p_id uuid)
RETURNS TABLE (
  id          uuid,
  name        text,
  description text,
  category    text,
  price_cents bigint,
  currency    text,
  auth_url    text,
  vendor_name text
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
    p.display_name AS vendor_name
  FROM   apps     a
  JOIN   profiles p ON p.id = a.vendor_id
  WHERE  a.id     = p_id
    AND  a.status = 'approved'
    AND  p.charges_enabled = true;
$$;

-- Distinct categories for the filter bar.
CREATE OR REPLACE FUNCTION public.list_marketplace_categories()
RETURNS TABLE (category text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT a.category
  FROM   apps     a
  JOIN   profiles p ON p.id = a.vendor_id
  WHERE  a.status = 'approved'
    AND  p.charges_enabled = true
    AND  a.category IS NOT NULL
  ORDER  BY a.category;
$$;
