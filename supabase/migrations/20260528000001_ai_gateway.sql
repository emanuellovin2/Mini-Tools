-- =============================================================================
-- #41 — AI Gateway (BYOK)
-- =============================================================================
-- provider_keys (envelope-encrypted), gateway_products, gateway_tokens,
-- gateway_reservations (reserve-then-settle), reserve_credits + release_reservation RPCs,
-- RLS trust boundaries, quota defaults.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE provider_key_provider AS ENUM ('openai', 'anthropic', 'openai_compat');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 1. provider_keys — envelope encryption: each row has its own DEK wrapped by
--    a versioned master key. Plaintext is never returned to clients.
--    ciphertext / dek_wrapped stored as base64 text (binary content).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.provider_keys (
  id          uuid                  NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Org ownership: members share keys within their org per role (#47)
  owner_id    uuid                  NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider    provider_key_provider NOT NULL,
  label       text                  NOT NULL DEFAULT '',
  -- AES-256-GCM(plaintext, DEK) — base64 encoded binary; never exposed via RLS
  ciphertext  text                  NOT NULL,
  -- AES-256-GCM(DEK, master_key[key_version]) — base64 encoded binary; never via RLS
  dek_wrapped text                  NOT NULL,
  key_version int                   NOT NULL DEFAULT 1,
  -- Last 4 chars of the original key for display (e.g. "sk-...abcd")
  last4       text                  NOT NULL,
  created_at  timestamptz           NOT NULL DEFAULT now(),

  CONSTRAINT provider_keys_last4_len CHECK (length(last4) = 4),
  CONSTRAINT provider_keys_label_len CHECK (length(label) <= 100)
);

CREATE INDEX IF NOT EXISTS provider_keys_owner_id_idx ON public.provider_keys (owner_id);

-- RLS: org members see metadata only; ciphertext/dek_wrapped excluded via view or
-- service-role-only column access. SELECT policy grants metadata access to members.
ALTER TABLE public.provider_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "provider_keys_member_select" ON public.provider_keys
  FOR SELECT
  USING (is_org_member(owner_id));

CREATE POLICY "provider_keys_member_insert" ON public.provider_keys
  FOR INSERT
  WITH CHECK (is_org_member(owner_id));

CREATE POLICY "provider_keys_member_delete" ON public.provider_keys
  FOR DELETE
  USING (is_org_member(owner_id));

-- ---------------------------------------------------------------------------
-- 2. gateway_products — links a solution to a usage meter + AI agent config.
--    Vendor creates one per agent/workflow solution to expose it via the gateway.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gateway_products (
  id              uuid                  NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  solution_id     uuid                  NOT NULL REFERENCES public.solutions(id) ON DELETE CASCADE,
  meter_id        uuid                  NOT NULL REFERENCES public.usage_meters(id),
  provider        provider_key_provider NOT NULL,
  model           text                  NOT NULL,
  system_prompt   text,
  cost_mode       usage_meter_cost_mode NOT NULL DEFAULT 'byok',
  -- Hard cap per request; prevents runaway spend on a single call
  max_tokens_cap  int                   NOT NULL DEFAULT 4096,
  -- Vendor-supplied default key id (optional; buyer BYOK overrides this)
  default_key_id  uuid                  REFERENCES public.provider_keys(id) ON DELETE SET NULL,
  created_at      timestamptz           NOT NULL DEFAULT now(),

  CONSTRAINT gateway_products_solution_unique UNIQUE (solution_id),
  CONSTRAINT gateway_products_model_nonempty CHECK (length(model) > 0),
  CONSTRAINT gateway_products_max_tokens_cap CHECK (max_tokens_cap BETWEEN 1 AND 200000)
);

CREATE INDEX IF NOT EXISTS gateway_products_meter_id_idx ON public.gateway_products (meter_id);

ALTER TABLE public.gateway_products ENABLE ROW LEVEL SECURITY;

-- Public can read product config (model, system_prompt is informational; key never exposed)
CREATE POLICY "gateway_products_public_select" ON public.gateway_products
  FOR SELECT USING (true);

-- ---------------------------------------------------------------------------
-- 3. gateway_tokens — hashed API tokens for non-browser gateway access.
--    Scoped per owner org × gateway product. Revocable instantly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gateway_tokens (
  id                      uuid    NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id                uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id              uuid    NOT NULL REFERENCES public.gateway_products(id) ON DELETE CASCADE,
  label                   text    NOT NULL DEFAULT '',
  -- SHA-256 of the raw token; raw token shown once at creation
  hashed_token            text    NOT NULL UNIQUE,
  prefix                  text    NOT NULL,
  -- Optional spend caps in cents (NULL = no cap)
  spend_cap_cents_daily   bigint  CHECK (spend_cap_cents_daily IS NULL OR spend_cap_cents_daily > 0),
  spend_cap_cents_monthly bigint  CHECK (spend_cap_cents_monthly IS NULL OR spend_cap_cents_monthly > 0),
  -- Rolling spend counters (reset by application sweep or pg_cron)
  spent_today_cents       bigint  NOT NULL DEFAULT 0,
  spent_month_cents       bigint  NOT NULL DEFAULT 0,
  spent_today_reset_at    date    NOT NULL DEFAULT CURRENT_DATE,
  spent_month_reset_at    date    NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::date,
  -- Anomaly protection: token auto-paused on spike
  paused_at               timestamptz,
  paused_reason           text,
  last_used_at            timestamptz,
  revoked_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gateway_tokens_owner_id_idx ON public.gateway_tokens (owner_id);
CREATE INDEX IF NOT EXISTS gateway_tokens_product_id_idx ON public.gateway_tokens (product_id);

ALTER TABLE public.gateway_tokens ENABLE ROW LEVEL SECURITY;

-- Org members see their own tokens (hashed_token excluded at SELECT via the service layer)
CREATE POLICY "gateway_tokens_member_select" ON public.gateway_tokens
  FOR SELECT
  USING (is_org_member(owner_id));

CREATE POLICY "gateway_tokens_member_insert" ON public.gateway_tokens
  FOR INSERT
  WITH CHECK (is_org_member(owner_id));

CREATE POLICY "gateway_tokens_member_update" ON public.gateway_tokens
  FOR UPDATE
  USING (is_org_member(owner_id));

CREATE POLICY "gateway_tokens_member_delete" ON public.gateway_tokens
  FOR DELETE
  USING (is_org_member(owner_id));

-- ---------------------------------------------------------------------------
-- 4. gateway_reservations — reserve-then-settle for token billing.
--    On a failed / aborted call the reservation simply expires (status = 'expired').
--    A sweeper pg_cron releases expired holds to avoid phantom balance deductions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gateway_reservations (
  id               uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  buyer_id         uuid        NOT NULL REFERENCES public.profiles(id),
  meter_id         uuid        NOT NULL REFERENCES public.usage_meters(id),
  estimated_cents  bigint      NOT NULL CHECK (estimated_cents >= 0),
  settled_cents    bigint      CHECK (settled_cents >= 0),
  status           text        NOT NULL DEFAULT 'held'
                               CHECK (status IN ('held', 'settled', 'released', 'expired')),
  -- Max hold time: 10 minutes. Sweeper sets status='expired' after this.
  expires_at       timestamptz NOT NULL DEFAULT now() + INTERVAL '10 minutes',
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Index for the sweeper (expired holds)
CREATE INDEX IF NOT EXISTS gateway_reservations_expires_idx
  ON public.gateway_reservations (expires_at)
  WHERE status = 'held';

-- Index for available-balance queries
CREATE INDEX IF NOT EXISTS gateway_reservations_buyer_held_idx
  ON public.gateway_reservations (buyer_id)
  WHERE status = 'held';

ALTER TABLE public.gateway_reservations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gateway_reservations_buyer_select" ON public.gateway_reservations
  FOR SELECT USING (buyer_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 5. reserve_credits RPC — atomically check available balance (balance minus held)
--    and insert a reservation if sufficient. Called before forwarding to provider.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_credits(
  p_buyer_id       uuid,
  p_meter_id       uuid,
  p_estimated_cents bigint,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance       bigint;
  v_held          bigint;
  v_available     bigint;
  v_reservation   uuid;
BEGIN
  -- Idempotency check: return existing reservation if same key supplied
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_reservation
    FROM gateway_reservations
    WHERE idempotency_key = p_idempotency_key
      AND buyer_id = p_buyer_id
      AND status IN ('held', 'settled');
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'reservation_id', v_reservation, 'deduped', true);
    END IF;
  END IF;

  -- Lock wallet row
  SELECT balance_cents INTO v_balance
  FROM credit_wallets
  WHERE buyer_id = p_buyer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'blocked', true, 'reason', 'no_wallet');
  END IF;

  -- Sum current held reservations for this buyer
  SELECT COALESCE(SUM(estimated_cents), 0) INTO v_held
  FROM gateway_reservations
  WHERE buyer_id = p_buyer_id
    AND status = 'held'
    AND expires_at > now();

  v_available := v_balance - v_held;

  IF v_available < p_estimated_cents THEN
    RETURN jsonb_build_object('ok', false, 'blocked', true, 'reason', 'insufficient_credits',
                              'available_cents', v_available);
  END IF;

  -- Insert reservation
  INSERT INTO gateway_reservations (buyer_id, meter_id, estimated_cents, idempotency_key)
  VALUES (p_buyer_id, p_meter_id, p_estimated_cents, p_idempotency_key)
  RETURNING id INTO v_reservation;

  RETURN jsonb_build_object('ok', true, 'reservation_id', v_reservation, 'deduped', false,
                            'available_cents', v_available - p_estimated_cents);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. release_reservation RPC — called on failed/aborted calls; no credit deduction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_reservation(
  p_reservation_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE gateway_reservations
  SET status = 'released'
  WHERE id = p_reservation_id
    AND status = 'held';
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. expire_gateway_reservations — sweep held reservations past their TTL.
--    Invoked by pg_cron every 5 minutes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_gateway_reservations()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE gateway_reservations
  SET status = 'expired'
  WHERE status = 'held'
    AND expires_at <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Quota defaults for new resource types
-- ---------------------------------------------------------------------------
INSERT INTO public.org_quotas (resource_type, default_limit) VALUES
  ('provider_keys', 10),
  ('gateway_tokens', 20)
ON CONFLICT (resource_type) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 9. pg_cron: expire held reservations every 5 minutes
--    (cron.schedule only exists when pg_cron extension is enabled)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'gateway-reservation-sweep',
      '*/5 * * * *',
      $$SELECT expire_gateway_reservations()$$
    );
  END IF;
END $$;
