-- =============================================================================
-- #40 — Usage metering ledger + usage-based billing
-- =============================================================================
-- usage_meters (pricing config), usage_events (append-only monthly partitions),
-- credit_wallets + credit_transactions (prepaid, no float),
-- record_usage RPC (atomic: ledger + draw-down + audit in one txn),
-- subscriptions.acquired_by + partner_owner_id (SPEC §13),
-- RLS trust boundaries.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE usage_meter_product_type AS ENUM ('gateway', 'workflow', 'connector', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE usage_meter_cost_mode AS ENUM ('byok', 'managed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE credit_transaction_type AS ENUM ('topup', 'drawdown', 'refund', 'grant');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 1. usage_meters — one row per metered product
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.usage_meters (
  id               uuid                     NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- org_id ownership (§15) — owner of this meter is the vendor/agency org
  owner_org_id     uuid                     NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_type     usage_meter_product_type NOT NULL,
  unit             text                     NOT NULL,
  -- Seam: USD enforced at app boundary. Column exists so multi-currency never needs a schema change.
  currency         text                     NOT NULL DEFAULT 'usd',
  -- Structured pricing: { model: 'flat'|'tiered'|'volume', tiers: [{up_to, vendor_unit_price_cents, platform_fee_cents}], included_allowance?, minimum_commitment_cents? }
  pricing          jsonb                    NOT NULL,
  cost_mode        usage_meter_cost_mode    NOT NULL DEFAULT 'byok',
  active           boolean                  NOT NULL DEFAULT true,
  created_at       timestamptz              NOT NULL DEFAULT now(),
  updated_at       timestamptz              NOT NULL DEFAULT now(),

  CONSTRAINT usage_meters_currency_usd CHECK (currency = 'usd'),
  CONSTRAINT usage_meters_unit_nonempty CHECK (length(unit) > 0),
  CONSTRAINT usage_meters_pricing_model CHECK (
    pricing ? 'model' AND pricing ? 'tiers' AND
    (pricing->>'model') IN ('flat', 'tiered', 'volume')
  )
);

CREATE INDEX IF NOT EXISTS usage_meters_owner_org_id_idx ON public.usage_meters (owner_org_id);

-- ---------------------------------------------------------------------------
-- 2. usage_events — append-only, monthly partitioned. Financial record: never purge.
--    Immutable: no UPDATE/DELETE RLS.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.usage_events (
  id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  meter_id             uuid        NOT NULL REFERENCES public.usage_meters(id),
  buyer_id             uuid        NOT NULL REFERENCES public.profiles(id),
  -- nullable: attribution inherited from linked subscription (affiliate/reseller)
  subscription_id      uuid        REFERENCES public.subscriptions(id),
  quantity             bigint      NOT NULL CHECK (quantity > 0),
  -- BYOK: informational only (buyer's provider key, not the platform's cost).
  -- managed: the actual provider cost; platform_share must cover this.
  provider_cost_cents  bigint      NOT NULL DEFAULT 0 CHECK (provider_cost_cents >= 0),
  billable_cents       bigint      NOT NULL CHECK (billable_cents >= 0),
  vendor_share_cents   bigint      NOT NULL CHECK (vendor_share_cents >= 0),
  platform_share_cents bigint      NOT NULL CHECK (platform_share_cents >= 0),
  reseller_share_cents bigint      CHECK (reseller_share_cents >= 0),
  affiliate_share_cents bigint     CHECK (affiliate_share_cents >= 0),
  -- Seam column; USD only enforced now
  currency             text        NOT NULL DEFAULT 'usd',
  -- App-layer dedup within 7-day window (cross-partition uniqueness not enforced at DB layer)
  idempotency_key      text,
  occurred_at          timestamptz NOT NULL,
  settled_at           timestamptz,
  -- Partition key — DEFAULT now(); never supply custom value unless within current partition window
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- Affiliate and reseller are mutually exclusive (§4, SPEC)
  CONSTRAINT usage_events_attrib_mutex CHECK (
    NOT (reseller_share_cents IS NOT NULL AND affiliate_share_cents IS NOT NULL)
  ),
  -- Sum invariant enforced by record_usage RPC; CHECK here as defense-in-depth
  CONSTRAINT usage_events_sum_check CHECK (
    vendor_share_cents
    + platform_share_cents
    + COALESCE(reseller_share_cents, 0)
    + COALESCE(affiliate_share_cents, 0)
    = billable_cents
  )
) PARTITION BY RANGE (created_at);

-- Create partitions: 2026-05 through 2027-06 (13 months ahead)
DO $$
DECLARE
  y  int;
  m  int;
  ts text;
  te text;
BEGIN
  FOR y IN 2026..2027 LOOP
    FOR m IN 1..12 LOOP
      -- Only create 2026-05 onwards, stop at 2027-06
      CONTINUE WHEN y = 2026 AND m < 5;
      CONTINUE WHEN y = 2027 AND m > 6;

      ts := to_char(make_date(y, m, 1), 'YYYY-MM-DD');
      te := to_char(
        CASE WHEN m = 12 THEN make_date(y + 1, 1, 1)
             ELSE make_date(y, m + 1, 1)
        END,
        'YYYY-MM-DD'
      );

      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.usage_events_%s_%s
           PARTITION OF public.usage_events
           FOR VALUES FROM (%L) TO (%L)',
        y,
        lpad(m::text, 2, '0'),
        ts,
        te
      );
    END LOOP;
  END LOOP;
END $$;

-- Indexes on partitioned table (propagate to all partitions)
CREATE INDEX IF NOT EXISTS usage_events_buyer_settled_idx
  ON public.usage_events (buyer_id, settled_at);
CREATE INDEX IF NOT EXISTS usage_events_meter_created_idx
  ON public.usage_events (meter_id, created_at);
CREATE INDEX IF NOT EXISTS usage_events_idempotency_key_idx
  ON public.usage_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Prepaid credit wallets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.credit_wallets (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- One wallet per buyer (enforced by UNIQUE)
  buyer_id        uuid        NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  currency        text        NOT NULL DEFAULT 'usd',
  balance_cents   bigint      NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credit_wallets_currency_usd CHECK (currency = 'usd')
);

CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id                       uuid                    NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_id                uuid                    NOT NULL REFERENCES public.credit_wallets(id) ON DELETE CASCADE,
  type                     credit_transaction_type NOT NULL,
  amount_cents             bigint                  NOT NULL CHECK (amount_cents > 0),
  usage_event_id           uuid,   -- set for drawdown/refund (not FK to avoid partition issues)
  stripe_payment_intent_id text,   -- set for topup
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_transactions_wallet_idx
  ON public.credit_transactions (wallet_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. record_usage — atomic RPC
--    Caller (lib/services/usage.ts) pre-computes all split amounts.
--    Returns: { ok, blocked, remaining_balance_cents, event_id }
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_usage(
  p_meter_id             uuid,
  p_buyer_id             uuid,
  p_subscription_id      uuid,
  p_quantity             bigint,
  p_provider_cost_cents  bigint,
  p_billable_cents       bigint,
  p_vendor_share_cents   bigint,
  p_platform_share_cents bigint,
  p_reseller_share_cents bigint,    -- NULL if no reseller
  p_affiliate_share_cents bigint,   -- NULL if no affiliate
  p_idempotency_key      text,
  p_occurred_at          timestamptz,
  p_actor_org_id         uuid       -- for audit_log
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet_id       uuid;
  v_balance         bigint;
  v_new_balance     bigint;
  v_event_id        uuid;
  v_existing_event  uuid;
BEGIN
  -- 1. Idempotency: check last 7 days for duplicate key
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_event
    FROM usage_events
    WHERE idempotency_key = p_idempotency_key
      AND created_at > now() - interval '7 days'
    LIMIT 1;

    IF FOUND THEN
      -- Deduped — return current wallet balance without modifying anything
      SELECT balance_cents INTO v_balance
      FROM credit_wallets
      WHERE buyer_id = p_buyer_id;
      RETURN jsonb_build_object(
        'ok', false,
        'deduped', true,
        'blocked', false,
        'remaining_balance_cents', COALESCE(v_balance, 0),
        'event_id', v_existing_event
      );
    END IF;
  END IF;

  -- 2. Lock wallet row (create if absent)
  INSERT INTO credit_wallets (buyer_id)
  VALUES (p_buyer_id)
  ON CONFLICT (buyer_id) DO NOTHING;

  SELECT id, balance_cents
  INTO v_wallet_id, v_balance
  FROM credit_wallets
  WHERE buyer_id = p_buyer_id
  FOR UPDATE;  -- row-level lock prevents double-spend

  -- 3. Balance check
  IF v_balance < p_billable_cents THEN
    RETURN jsonb_build_object(
      'ok', false,
      'deduped', false,
      'blocked', true,
      'remaining_balance_cents', v_balance,
      'event_id', null
    );
  END IF;

  v_new_balance := v_balance - p_billable_cents;

  -- 4. Insert usage_event
  v_event_id := gen_random_uuid();
  INSERT INTO usage_events (
    id, meter_id, buyer_id, subscription_id,
    quantity, provider_cost_cents, billable_cents,
    vendor_share_cents, platform_share_cents, reseller_share_cents, affiliate_share_cents,
    idempotency_key, occurred_at
  ) VALUES (
    v_event_id, p_meter_id, p_buyer_id, p_subscription_id,
    p_quantity, p_provider_cost_cents, p_billable_cents,
    p_vendor_share_cents, p_platform_share_cents, p_reseller_share_cents, p_affiliate_share_cents,
    p_idempotency_key, p_occurred_at
  );

  -- 5. Draw down wallet
  UPDATE credit_wallets
  SET balance_cents = v_new_balance,
      updated_at    = now()
  WHERE id = v_wallet_id;

  -- 6. Credit transaction record
  INSERT INTO credit_transactions (wallet_id, type, amount_cents, usage_event_id)
  VALUES (v_wallet_id, 'drawdown', p_billable_cents, v_event_id);

  -- 7. Audit log
  INSERT INTO audit_log (actor_id, actor_org_id, action, resource_type, resource_id, metadata)
  VALUES (
    p_buyer_id, p_actor_org_id, 'usage.recorded', 'usage_event', v_event_id,
    jsonb_build_object(
      'meter_id', p_meter_id,
      'quantity', p_quantity,
      'billable_cents', p_billable_cents,
      'remaining_balance_cents', v_new_balance
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'deduped', false,
    'blocked', false,
    'remaining_balance_cents', v_new_balance,
    'event_id', v_event_id
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. subscriptions: acquired_by + partner_owner_id (SPEC §13)
--    Immutable after insert — written only by service role at subscribe time.
--    Backfill existing rows to 'platform' (marketplace default).
-- ---------------------------------------------------------------------------
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS acquired_by      text NOT NULL DEFAULT 'platform'
    CHECK (acquired_by IN ('platform', 'partner'));

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS partner_owner_id uuid REFERENCES public.profiles(id);

-- Enforce: partner_owner_id non-null iff acquired_by = 'partner'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_acquired_by_partner_check'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_acquired_by_partner_check
      CHECK ((acquired_by = 'partner') = (partner_owner_id IS NOT NULL));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. topup_credits — credits wallet from a verified Stripe payment
--    Called by webhook handler (payment_intent.succeeded).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.topup_credits(
  p_buyer_id                uuid,
  p_amount_cents            bigint,
  p_stripe_payment_intent_id text,
  p_actor_org_id            uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet_id   uuid;
  v_new_balance bigint;
BEGIN
  -- Idempotency: skip if this payment intent was already credited
  IF EXISTS (
    SELECT 1 FROM credit_transactions
    WHERE stripe_payment_intent_id = p_stripe_payment_intent_id
  ) THEN
    SELECT balance_cents INTO v_new_balance
    FROM credit_wallets WHERE buyer_id = p_buyer_id;
    RETURN jsonb_build_object('ok', false, 'deduped', true, 'balance_cents', COALESCE(v_new_balance, 0));
  END IF;

  -- Upsert wallet
  INSERT INTO credit_wallets (buyer_id)
  VALUES (p_buyer_id)
  ON CONFLICT (buyer_id) DO NOTHING;

  UPDATE credit_wallets
  SET balance_cents = balance_cents + p_amount_cents,
      updated_at    = now()
  WHERE buyer_id = p_buyer_id
  RETURNING id, balance_cents INTO v_wallet_id, v_new_balance;

  INSERT INTO credit_transactions (
    wallet_id, type, amount_cents, stripe_payment_intent_id
  ) VALUES (
    v_wallet_id, 'topup', p_amount_cents, p_stripe_payment_intent_id
  );

  INSERT INTO audit_log (actor_id, actor_org_id, action, resource_type, resource_id, metadata)
  VALUES (
    p_buyer_id, p_actor_org_id, 'credits.topup', 'credit_wallet', v_wallet_id,
    jsonb_build_object(
      'amount_cents', p_amount_cents,
      'stripe_payment_intent_id', p_stripe_payment_intent_id,
      'new_balance_cents', v_new_balance
    )
  );

  RETURN jsonb_build_object('ok', true, 'deduped', false, 'balance_cents', v_new_balance);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.usage_meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;
-- usage_events: no direct RLS (service role only for write; reads via RPCs/views)

-- usage_meters: owner org members can read/write own meters; service role full
CREATE POLICY usage_meters_owner_read ON public.usage_meters
  FOR SELECT USING (is_org_member(owner_org_id, 'member'));

CREATE POLICY usage_meters_owner_write ON public.usage_meters
  FOR ALL USING (is_org_member(owner_org_id, 'admin'));

-- credit_wallets: buyer reads own wallet only
CREATE POLICY credit_wallets_buyer_read ON public.credit_wallets
  FOR SELECT USING (buyer_id = auth.uid());

-- credit_transactions: buyer reads own transactions
CREATE POLICY credit_transactions_buyer_read ON public.credit_transactions
  FOR SELECT USING (
    wallet_id IN (
      SELECT id FROM credit_wallets WHERE buyer_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 8. Helper views for accounting / reconciliation (admin-only via service role)
-- ---------------------------------------------------------------------------

-- Outstanding credit liability = prepaid credits not yet drawn (owed as service)
CREATE OR REPLACE VIEW public.v_credit_liability AS
SELECT
  SUM(balance_cents) AS total_liability_cents,
  COUNT(*) AS wallet_count
FROM public.credit_wallets;

-- Partner payable = unsettled partner shares (owed to vendors/resellers/affiliates)
CREATE OR REPLACE VIEW public.v_usage_partner_payable AS
SELECT
  SUM(vendor_share_cents)             AS vendor_payable_cents,
  SUM(COALESCE(reseller_share_cents, 0)) AS reseller_payable_cents,
  SUM(COALESCE(affiliate_share_cents, 0)) AS affiliate_payable_cents,
  COUNT(*) AS unsettled_event_count
FROM public.usage_events
WHERE settled_at IS NULL;

-- Recognized platform revenue = platform share on settled events
CREATE OR REPLACE VIEW public.v_usage_platform_revenue AS
SELECT
  SUM(platform_share_cents) AS recognized_revenue_cents,
  COUNT(*) AS settled_event_count
FROM public.usage_events
WHERE settled_at IS NOT NULL;
