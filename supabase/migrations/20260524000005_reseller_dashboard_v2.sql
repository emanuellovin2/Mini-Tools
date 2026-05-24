-- #34 Reseller dashboard v2: snapshot columns for vendor change alert detection
ALTER TABLE reseller_offers
  ADD COLUMN IF NOT EXISTS last_observed_floor_cents integer,
  ADD COLUMN IF NOT EXISTS last_observed_openness text;

-- Seed from current state for existing rows
UPDATE reseller_offers ro
SET
  last_observed_floor_cents = ro.vendor_floor_snapshot_cents,
  last_observed_openness    = p.reseller_openness
FROM apps a
JOIN profiles p ON p.id = a.vendor_id
WHERE a.id = ro.app_id
  AND ro.last_observed_floor_cents IS NULL;
