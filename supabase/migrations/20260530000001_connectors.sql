-- =============================================================================
-- #43 — Connectors / integrations
-- =============================================================================
-- connector_accounts: encrypted OAuth + API-key credential vault.
-- Each account is org-owned; org members share connections across workflows.
-- Envelope encryption reuses the #41 AES-256-GCM pattern (same master keys).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. connector_accounts — per-org credential store
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.connector_accounts (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Org ownership: all members share connections within their org
  org_id              uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Registry key matching ConnectorDef.id (e.g. 'gmail', 'slack', 'sheets', 'http')
  connector_id        text        NOT NULL,
  -- Human-readable label set by the user
  label               text        NOT NULL DEFAULT '',
  -- Scopes granted during OAuth (empty for api_key / none auth types)
  scopes              text[]      NOT NULL DEFAULT '{}',
  -- Encrypted access token (AES-256-GCM envelope, same scheme as provider_keys)
  ciphertext          text        NOT NULL,
  dek_wrapped         text        NOT NULL,
  key_version         int         NOT NULL DEFAULT 1,
  -- Encrypted refresh token (nullable — only present for oauth2 flows)
  refresh_ciphertext  text,
  refresh_dek_wrapped text,
  refresh_key_version int,
  -- When the access token expires; NULL = non-expiring (api_key / static token)
  expires_at          timestamptz,
  -- Provider-specific account identifier (e.g. Gmail address, Slack workspace ID)
  external_id         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT connector_accounts_connector_id_nonempty CHECK (length(connector_id) > 0),
  CONSTRAINT connector_accounts_label_len CHECK (length(label) <= 100),
  -- refresh fields must be all-or-nothing
  CONSTRAINT connector_accounts_refresh_consistent
    CHECK (
      (refresh_ciphertext IS NULL) = (refresh_dek_wrapped IS NULL) AND
      (refresh_ciphertext IS NULL) = (refresh_key_version IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS connector_accounts_org_id_idx
  ON public.connector_accounts (org_id);
CREATE INDEX IF NOT EXISTS connector_accounts_org_connector_idx
  ON public.connector_accounts (org_id, connector_id);

-- updated_at trigger
CREATE OR REPLACE TRIGGER connector_accounts_updated_at
  BEFORE UPDATE ON public.connector_accounts
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ---------------------------------------------------------------------------
-- 2. RLS
--    SELECT/INSERT/DELETE: org members only.
--    ciphertext / dek_wrapped columns are never exposed via RLS policies —
--    they are service-role-only (read by the executor, never returned to UI).
-- ---------------------------------------------------------------------------
ALTER TABLE public.connector_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "connector_accounts_member_select" ON public.connector_accounts
  FOR SELECT
  USING (is_org_member(org_id));

CREATE POLICY "connector_accounts_member_insert" ON public.connector_accounts
  FOR INSERT
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "connector_accounts_member_update" ON public.connector_accounts
  FOR UPDATE
  USING (is_org_member(org_id))
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "connector_accounts_member_delete" ON public.connector_accounts
  FOR DELETE
  USING (is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- 3. Quota default for connector_accounts
-- ---------------------------------------------------------------------------
INSERT INTO public.org_quotas (resource_type, default_limit) VALUES
  ('connector_accounts', 20)
ON CONFLICT (resource_type) DO NOTHING;
