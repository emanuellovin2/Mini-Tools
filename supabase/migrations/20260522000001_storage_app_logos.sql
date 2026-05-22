-- Storage bucket for vendor app logos (public reads, vendor-prefixed writes)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'app-logos',
  'app-logos',
  true,
  1048576,
  ARRAY['image/png','image/jpeg','image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Public read (logos are public assets)
CREATE POLICY "app_logos_public_select" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'app-logos');

-- Vendor may insert only under their own vendor_id/ prefix
CREATE POLICY "app_logos_vendor_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'app-logos'
    AND (storage.foldername(name))[1] = (auth.uid())::text
    AND (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'vendor'
  );

-- Vendor may update only their own objects
CREATE POLICY "app_logos_vendor_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'app-logos'
    AND (storage.foldername(name))[1] = (auth.uid())::text
    AND (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'vendor'
  )
  WITH CHECK (
    bucket_id = 'app-logos'
    AND (storage.foldername(name))[1] = (auth.uid())::text
    AND (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'vendor'
  );

-- Vendor may delete only their own objects
CREATE POLICY "app_logos_vendor_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'app-logos'
    AND (storage.foldername(name))[1] = (auth.uid())::text
    AND (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'vendor'
  );
