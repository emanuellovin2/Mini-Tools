-- Detach a partition safely (if it exists) — used by partition-rotation-cron.
-- Does NOT drop: data must be archived externally before partition is discarded.

CREATE OR REPLACE FUNCTION public.detach_partition_if_exists(
  p_parent    text,
  p_partition text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = p_partition
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DETACH PARTITION public.%I', p_parent, p_partition);
  END IF;
END;
$$;
