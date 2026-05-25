/**
 * Connectors service (#43).
 *
 * Responsibilities:
 *   - listConnectorDefs       — static registry
 *   - connectAccount          — generate OAuth consent URL with signed state
 *   - handleOAuthCallback     — exchange code, encrypt + store tokens
 *   - refreshTokenIfExpired   — auto-refresh before a step runs
 *   - listConnectorAccounts   — metadata (no ciphertext) for UI
 *   - revokeAccount           — hard-delete stored credentials
 *   - runConnectorAction      — load + decrypt account, dispatch to handler
 *
 * Token encryption reuses lib/gateway/crypto (same AES-256-GCM envelope + master keys).
 * OAuth state: HMAC-SHA256 signed, base64url encoded, 15-minute expiry.
 */

import { createAdminClient } from "@/lib/services/supabase";
import { encryptSecret, decryptSecret, type EncryptedSecret } from "@/lib/gateway/crypto";
import { enforceQuota } from "@/lib/quotas/enforce";
import {
  CONNECTORS,
  getConnector,
  validateActionInput,
  type ConnectorDef,
} from "@/lib/connectors/registry";
import { executeHttpAction } from "@/lib/connectors/handlers/http";
import { executeGmailAction } from "@/lib/connectors/handlers/gmail";
import { executeSlackAction } from "@/lib/connectors/handlers/slack";
import { executeSheetsAction } from "@/lib/connectors/handlers/sheets";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

const STATE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// OAuth state — HMAC-SHA256 signed to prevent CSRF
// ---------------------------------------------------------------------------

function getStateSecret(): ArrayBuffer {
  const secret = process.env.CONNECTOR_STATE_SECRET;
  if (!secret) throw new Error("CONNECTOR_STATE_SECRET is not set");
  const encoded = new TextEncoder().encode(secret);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

export async function signState(payload: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    getStateSecret(),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const body = JSON.stringify({ ...payload, exp: Date.now() + STATE_EXPIRY_MS });
  const bodyB64 = Buffer.from(body).toString("base64url");
  const bodyBytes = new TextEncoder().encode(bodyB64);
  const bodyBuf = bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer;
  const sig = await crypto.subtle.sign("HMAC", key, bodyBuf);
  const sigB64 = Buffer.from(sig).toString("base64url");
  return `${bodyB64}.${sigB64}`;
}

export async function verifyState(
  state: string
): Promise<Record<string, unknown> | null> {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [bodyB64, sigB64] = parts;

  const key = await crypto.subtle.importKey(
    "raw",
    getStateSecret(),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const bodyBytes = new TextEncoder().encode(bodyB64);
  const bodyBuf = bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer;
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    Buffer.from(sigB64, "base64url"),
    bodyBuf
  );
  if (!valid) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listConnectorDefs(): ConnectorDef[] {
  return CONNECTORS;
}

/** Returns the OAuth consent URL; the caller redirects the user there. */
export async function connectAccount(
  orgId: string,
  connectorId: string,
  label: string,
  redirectUri: string
): Promise<{ authUrl: string }> {
  const def = getConnector(connectorId);
  if (!def) throw new Error(`connector: unknown connector '${connectorId}'`);
  if (def.auth !== "oauth2") {
    throw new Error(`connector: '${connectorId}' does not use OAuth2`);
  }
  if (!def.authUrl) throw new Error(`connector: no authUrl for '${connectorId}'`);

  await enforceQuota(orgId, "connectors");

  const state = await signState({ orgId, connectorId, label, redirectUri });
  const clientId = getClientId(connectorId);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: def.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });

  return { authUrl: `${def.authUrl}?${params}` };
}

/** Called by the OAuth callback route after the provider redirects back. */
export async function handleOAuthCallback(
  connectorId: string,
  code: string,
  state: string,
  redirectUri: string
): Promise<{ accountId: string }> {
  const def = getConnector(connectorId);
  if (!def || def.auth !== "oauth2" || !def.tokenUrl) {
    throw new Error(`connector: invalid connector for OAuth '${connectorId}'`);
  }

  const payload = await verifyState(state);
  if (!payload) throw new Error("connector: invalid or expired OAuth state");

  const orgId = payload.orgId as string;
  const label = (payload.label as string) || def.name;

  // Exchange code for tokens
  const tokens = await exchangeCode(connectorId, def.tokenUrl, code, redirectUri);

  // Encrypt access token
  const encAccess = await encryptSecret(tokens.access_token);

  // Encrypt refresh token if present
  let encRefresh: EncryptedSecret | null = null;
  if (tokens.refresh_token) {
    encRefresh = await encryptSecret(tokens.refresh_token);
  }

  // Resolve external identifier (e.g. Gmail address)
  const externalId = await resolveExternalId(connectorId, tokens.access_token);

  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("connector_accounts")
    .insert({
      org_id: orgId,
      connector_id: connectorId,
      label,
      scopes: def.scopes,
      ciphertext: encAccess.ciphertext,
      dek_wrapped: encAccess.dek_wrapped,
      key_version: encAccess.key_version,
      refresh_ciphertext: encRefresh?.ciphertext ?? null,
      refresh_dek_wrapped: encRefresh?.dek_wrapped ?? null,
      refresh_key_version: encRefresh?.key_version ?? null,
      expires_at: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
      external_id: externalId,
    })
    .select("id")
    .single();

  if (error) throw new Error(`connector: failed to store account: ${error.message}`);
  return { accountId: data.id as string };
}

/** Returns metadata for the UI — never returns ciphertext. */
export async function listConnectorAccounts(
  orgId: string
): Promise<
  Array<{
    id: string;
    connector_id: string;
    label: string;
    scopes: string[];
    expires_at: string | null;
    external_id: string | null;
    created_at: string;
  }>
> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("connector_accounts")
    .select("id, connector_id, label, scopes, expires_at, external_id, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`listConnectorAccounts: ${error.message}`);
  return data ?? [];
}

/** Hard-deletes the account row and any stored tokens immediately. */
export async function revokeAccount(orgId: string, accountId: string): Promise<void> {
  const admin = createAdminClient() as AnyAdmin;
  const { error } = await admin
    .from("connector_accounts")
    .delete()
    .eq("id", accountId)
    .eq("org_id", orgId);

  if (error) throw new Error(`revokeAccount: ${error.message}`);
}

/**
 * Load, optionally refresh, and dispatch a connector action.
 * Used by the workflow executor for connector steps.
 */
export async function runConnectorAction(
  accountId: string,
  actionId: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const admin = createAdminClient() as AnyAdmin;
  const { data: row, error } = await admin
    .from("connector_accounts")
    .select(
      "id, org_id, connector_id, ciphertext, dek_wrapped, key_version, refresh_ciphertext, refresh_dek_wrapped, refresh_key_version, expires_at"
    )
    .eq("id", accountId)
    .single();

  if (error || !row) throw new Error(`connector: account ${accountId} not found`);

  // Validate action input against registry schema before touching credentials
  const validated = validateActionInput(row.connector_id as string, actionId, input);

  // Refresh token if within 5 minutes of expiry or already expired
  const account = await ensureFreshToken(row);

  return dispatch(row.connector_id as string, actionId, validated, account.access_token);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function exchangeCode(
  connectorId: string,
  tokenUrl: string,
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  const clientId = getClientId(connectorId);
  const clientSecret = getClientSecret(connectorId);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`connector: token exchange failed ${res.status}: ${err}`);
  }

  return res.json() as Promise<TokenResponse>;
}

async function refreshAccessToken(
  connectorId: string,
  refreshToken: string
): Promise<TokenResponse> {
  const def = getConnector(connectorId);
  if (!def?.tokenUrl) throw new Error(`connector: no tokenUrl for '${connectorId}'`);

  const clientId = getClientId(connectorId);
  const clientSecret = getClientSecret(connectorId);

  const res = await fetch(def.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`connector: token refresh failed ${res.status}: ${err}`);
  }

  return res.json() as Promise<TokenResponse>;
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh if expiring within 5 min

interface AccountRow {
  id: string;
  connector_id: string;
  ciphertext: string;
  dek_wrapped: string;
  key_version: number;
  refresh_ciphertext: string | null;
  refresh_dek_wrapped: string | null;
  refresh_key_version: number | null;
  expires_at: string | null;
}

async function ensureFreshToken(row: AccountRow): Promise<{ access_token: string }> {
  const needsRefresh =
    row.expires_at !== null &&
    new Date(row.expires_at).getTime() - Date.now() < REFRESH_BUFFER_MS;

  if (!needsRefresh) {
    const access_token = await decryptSecret({
      ciphertext: row.ciphertext,
      dek_wrapped: row.dek_wrapped,
      key_version: row.key_version,
    });
    return { access_token };
  }

  // Need to refresh
  if (!row.refresh_ciphertext || !row.refresh_dek_wrapped || row.refresh_key_version == null) {
    throw new Error("connector: access token expired and no refresh token available — reconnect");
  }

  const refreshToken = await decryptSecret({
    ciphertext: row.refresh_ciphertext,
    dek_wrapped: row.refresh_dek_wrapped,
    key_version: row.refresh_key_version,
  });

  const tokens = await refreshAccessToken(row.connector_id, refreshToken);

  // Re-encrypt new access token
  const encAccess = await encryptSecret(tokens.access_token);

  // Re-encrypt new refresh token if the provider rotated it
  let encRefresh: EncryptedSecret | null = null;
  if (tokens.refresh_token) {
    encRefresh = await encryptSecret(tokens.refresh_token);
  }

  const admin = createAdminClient() as AnyAdmin;
  await admin
    .from("connector_accounts")
    .update({
      ciphertext: encAccess.ciphertext,
      dek_wrapped: encAccess.dek_wrapped,
      key_version: encAccess.key_version,
      ...(encRefresh
        ? {
            refresh_ciphertext: encRefresh.ciphertext,
            refresh_dek_wrapped: encRefresh.dek_wrapped,
            refresh_key_version: encRefresh.key_version,
          }
        : {}),
      expires_at: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
    })
    .eq("id", row.id);

  return { access_token: tokens.access_token };
}

async function resolveExternalId(
  connectorId: string,
  accessToken: string
): Promise<string | null> {
  try {
    if (connectorId === "gmail" || connectorId === "sheets") {
      const res = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo?fields=email",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(5_000),
        }
      );
      if (res.ok) {
        const data = (await res.json()) as { email?: string };
        return data.email ?? null;
      }
    }
    if (connectorId === "slack") {
      const res = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { team?: string; user?: string };
        return data.team ? `${data.user ?? ""}@${data.team}` : null;
      }
    }
  } catch {
    // Non-fatal — external_id is display-only
  }
  return null;
}

async function dispatch(
  connectorId: string,
  actionId: string,
  input: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (connectorId) {
    case "http":
      return executeHttpAction(actionId, input as unknown as Parameters<typeof executeHttpAction>[1], {});
    case "gmail":
      return executeGmailAction(actionId, input, { access_token: accessToken });
    case "slack":
      return executeSlackAction(actionId, input, { access_token: accessToken });
    case "sheets":
      return executeSheetsAction(actionId, input, { access_token: accessToken });
    default:
      throw new Error(`connector: no handler for '${connectorId}'`);
  }
}

function getClientId(connectorId: string): string {
  if (connectorId === "gmail" || connectorId === "sheets") {
    const id = process.env.GOOGLE_CLIENT_ID;
    if (!id) throw new Error("GOOGLE_CLIENT_ID is not set");
    return id;
  }
  if (connectorId === "slack") {
    const id = process.env.SLACK_CLIENT_ID;
    if (!id) throw new Error("SLACK_CLIENT_ID is not set");
    return id;
  }
  throw new Error(`connector: no client ID config for '${connectorId}'`);
}

function getClientSecret(connectorId: string): string {
  if (connectorId === "gmail" || connectorId === "sheets") {
    const secret = process.env.GOOGLE_CLIENT_SECRET;
    if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
    return secret;
  }
  if (connectorId === "slack") {
    const secret = process.env.SLACK_CLIENT_SECRET;
    if (!secret) throw new Error("SLACK_CLIENT_SECRET is not set");
    return secret;
  }
  throw new Error(`connector: no client secret config for '${connectorId}'`);
}
