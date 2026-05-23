-- pending_transfers: queue rows when an affiliate or reseller transfer cannot
-- be created at invoice.paid because their Stripe Connect account is not yet
-- payout-ready (no stripe_account_id, or the required capability is disabled).
-- Processed by handleAccountUpdated when the capability flips on.

CREATE TABLE public.pending_transfers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_kind  text        NOT NULL CHECK (recipient_kind IN ('affiliate', 'reseller')),
  invoice_id      text        NOT NULL,
  amount_cents    bigint      NOT NULL CHECK (amount_cents > 0),
  transfer_group  text        NOT NULL,
  reason          text        NOT NULL,                    -- 'no_stripe_account' | 'capability_disabled'
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  attempts        int         NOT NULL DEFAULT 0,
  last_error      text,
  transfer_id     text,                                    -- set when status='completed'
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  CONSTRAINT pending_transfers_idempotency
    UNIQUE (invoice_id, recipient_id, recipient_kind)
);

CREATE INDEX pending_transfers_recipient_pending_idx
  ON public.pending_transfers (recipient_id)
  WHERE status = 'pending';

ALTER TABLE public.pending_transfers ENABLE ROW LEVEL SECURITY;

-- Recipient may see their own queued/processed transfers (so dashboards can surface them).
CREATE POLICY "pending_transfers_select_own"
  ON public.pending_transfers FOR SELECT
  USING (recipient_id = auth.uid());

-- Admin may see all rows.
CREATE POLICY "pending_transfers_select_admin"
  ON public.pending_transfers FOR SELECT
  USING (public.get_current_user_role() = 'admin');

-- Writes: service role only (webhook handler). No INSERT/UPDATE policies needed.
