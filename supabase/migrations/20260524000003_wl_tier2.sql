-- =============================================================================
-- #29 — White-label Tier 2
-- =============================================================================

-- (A) Vendor reseller-openness toggle (3-state enum). Default open_to_resellers.
CREATE TYPE public.vendor_reseller_openness AS ENUM (
  'closed', 'open_to_resellers', 'open_to_wl'
);

ALTER TABLE public.profiles
  ADD COLUMN reseller_openness public.vendor_reseller_openness
    NOT NULL DEFAULT 'open_to_resellers';

COMMENT ON COLUMN public.profiles.reseller_openness IS
  'Vendor toggle for reseller program. closed = no resellers; open_to_resellers (default) = Tier 1 only, vendor receives exact floor on reseller sales (status quo); open_to_wl = Tier 1 + Tier 2 allowed, vendor receives floor + 33% of platform commission as kickback. Direct sales always use the 12/8/5/3% tier system regardless of this toggle. Vendor never pays a per-sale tax in any state.';

CREATE INDEX profiles_reseller_openness_idx ON public.profiles (reseller_openness)
  WHERE role = 'vendor';

-- (A.1) Reseller global mini-branding — applied to all Tier 1 storefront pages (free, included in base sub)
ALTER TABLE public.profiles
  ADD COLUMN wl_global_logo_url     text,
  ADD COLUMN wl_global_brand_color  text
    CHECK (wl_global_brand_color IS NULL OR wl_global_brand_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN wl_global_display_name text
    CHECK (wl_global_display_name IS NULL
      OR (char_length(wl_global_display_name) BETWEEN 2 AND 60));

COMMENT ON COLUMN public.profiles.wl_global_logo_url IS
  'Optional reseller global logo applied to Tier 1 storefront mini-header. NULL = use platform branding. Same magic-bytes + deny-list validation as Tier 2 per-offer logos.';

-- Mini-branding is all-or-nothing — either all three set or none.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_wl_global_complete CHECK (
    (wl_global_logo_url IS NULL AND wl_global_brand_color IS NULL AND wl_global_display_name IS NULL)
    OR
    (wl_global_logo_url IS NOT NULL AND wl_global_brand_color IS NOT NULL AND wl_global_display_name IS NOT NULL)
  );

-- (B) Reseller offer — Tier 2 fields
ALTER TABLE public.reseller_offers
  ADD COLUMN wl_tier smallint NOT NULL DEFAULT 1
    CHECK (wl_tier IN (1, 2)),
  ADD COLUMN wl_logo_url text,
  ADD COLUMN wl_brand_color text
    CHECK (wl_brand_color IS NULL OR wl_brand_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN wl_display_name text,
  ADD COLUMN wl_stripe_subscription_id text,
  ADD COLUMN wl_trial_end timestamptz,
  ADD COLUMN wl_status text NOT NULL DEFAULT 'inactive'
    CHECK (wl_status IN ('inactive', 'trialing', 'active', 'past_due', 'canceled')),
  ADD COLUMN wl_last_sale_at timestamptz;

CREATE UNIQUE INDEX reseller_offers_wl_stripe_sub_unique
  ON public.reseller_offers (wl_stripe_subscription_id)
  WHERE wl_stripe_subscription_id IS NOT NULL;

CREATE INDEX reseller_offers_wl_tier_idx ON public.reseller_offers (wl_tier) WHERE wl_tier = 2;

-- Tier 2 requires branding + paying Stripe subscription
ALTER TABLE public.reseller_offers
  ADD CONSTRAINT reseller_offers_wl_branding_complete
    CHECK (
      wl_tier = 1
      OR (
        wl_tier = 2
        AND wl_logo_url IS NOT NULL
        AND wl_brand_color IS NOT NULL
        AND wl_display_name IS NOT NULL
        AND char_length(wl_display_name) BETWEEN 2 AND 60
        AND wl_stripe_subscription_id IS NOT NULL
        AND wl_status IN ('trialing', 'active')
      )
    );

-- (C) Subscription snapshots — wl_tier AND vendor openness at subscribe time (immutable after insert)
ALTER TABLE public.subscriptions
  ADD COLUMN reseller_wl_tier_snapshot smallint
    CHECK (reseller_wl_tier_snapshot IS NULL OR reseller_wl_tier_snapshot IN (1, 2)),
  ADD COLUMN vendor_openness_snapshot public.vendor_reseller_openness;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_reseller_snapshots_check
    CHECK (
      (reseller_id IS NULL AND reseller_wl_tier_snapshot IS NULL AND vendor_openness_snapshot IS NULL)
      OR
      (reseller_id IS NOT NULL AND reseller_wl_tier_snapshot IS NOT NULL AND vendor_openness_snapshot IN ('open_to_resellers','open_to_wl'))
    );

-- (D) Backfill — grandfather existing reseller subs at status quo (exact-floor, no kickback)
-- vendor_openness_snapshot = 'open_to_resellers' preserves exact-floor outcome.
-- Vendor never agreed to open_to_wl; backfilling to that would silently grant kickback.
UPDATE public.subscriptions
  SET reseller_wl_tier_snapshot = 1,
      vendor_openness_snapshot  = 'open_to_resellers'
  WHERE reseller_id IS NOT NULL
    AND reseller_wl_tier_snapshot IS NULL;
