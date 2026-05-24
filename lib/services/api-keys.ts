/**
 * Partner platform API keys.
 *
 * Keys are stored as SHA-256 hashes; the full key is shown exactly once at creation.
 * Test-mode keys block irreversible side effects (emails, payouts).
 * Every mutating /api/v1/* request accepts an Idempotency-Key header.
 */
import { createAdminClient } from "@/lib/services/supabase";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { nanoid } from "nanoid";

export const API_KEY_SCOPES = [
  "read:analytics",
  "manage:products",
  "manage:offers",
  "manage:links",
  "billing:credits",
  "run:workflows",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKey {
  id: string;
  org_id: string;
  name: string;
  prefix: string;
  mode: "test" | "live";
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildKeyPrefix(mode: "test" | "live"): string {
  return `pk_${mode}_${nanoid(6)}`;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createApiKey(args: {
  orgId: string;
  name: string;
  mode: "test" | "live";
  scopes: ApiKeyScope[];
}): Promise<{ key: ApiKey; plaintext: string }> {
  const prefix = buildKeyPrefix(args.mode);
  const secret = nanoid(32);
  const plaintext = `${prefix}${secret}`;
  const hashed = await sha256Hex(plaintext);

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from("api_keys")
    .insert({
      org_id: args.orgId,
      name: args.name,
      hashed_key: hashed,
      prefix,
      mode: args.mode,
      scopes: args.scopes,
    })
    .select("id, org_id, name, prefix, mode, scopes, last_used_at, revoked_at, created_at")
    .single();
  if (error) throw new Error(`createApiKey: ${error.message}`);
  return { key: data, plaintext };
}

export async function listApiKeys(orgId: string): Promise<ApiKey[]> {
  const supabase = await createServerSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("api_keys")
    .select("id, org_id, name, prefix, mode, scopes, last_used_at, revoked_at, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listApiKeys: ${error.message}`);
  return data ?? [];
}

export async function revokeApiKey(id: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null);
  if (error) throw new Error(`revokeApiKey: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Request-time validation — used by /api/v1/* middleware
// ---------------------------------------------------------------------------

export interface ValidatedKey {
  orgId: string;
  mode: "test" | "live";
  scopes: string[];
}

/** Resolve a raw Bearer token to its org + scopes. Returns null if invalid/revoked. */
export async function validateApiKey(
  rawKey: string
): Promise<ValidatedKey | null> {
  const hashed = await sha256Hex(rawKey);
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from("api_keys")
    .select("id, org_id, mode, scopes, revoked_at")
    .eq("hashed_key", hashed)
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;

  // Touch last_used_at fire-and-forget
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (admin as any)
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => {});

  return { orgId: data.org_id, mode: data.mode, scopes: data.scopes };
}

// ---------------------------------------------------------------------------
// Idempotency key store
// ---------------------------------------------------------------------------

export interface IdempotencyRecord {
  response_status: number;
  response_body: unknown;
}

/** Replay cached response if key+hash match. Returns null on first call. */
export async function checkIdempotencyKey(
  orgId: string,
  key: string,
  requestHash: string
): Promise<{ cached: true; record: IdempotencyRecord } | { cached: false; conflict: boolean }> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from("idempotency_keys")
    .select("request_hash, response_status, response_body, created_at")
    .eq("org_id", orgId)
    .eq("idempotency_key", key)
    .maybeSingle();

  if (!data) return { cached: false, conflict: false };

  // Expired (>24h) — treat as new
  const age = Date.now() - new Date(data.created_at).getTime();
  if (age > 24 * 60 * 60 * 1000) return { cached: false, conflict: false };

  if (data.request_hash !== requestHash) return { cached: false, conflict: true };

  return {
    cached: true,
    record: { response_status: data.response_status, response_body: data.response_body },
  };
}

export async function storeIdempotencyKey(
  orgId: string,
  key: string,
  requestHash: string,
  responseStatus: number,
  responseBody: unknown
): Promise<void> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("idempotency_keys").insert({
    org_id: orgId,
    idempotency_key: key,
    request_hash: requestHash,
    response_status: responseStatus,
    response_body: responseBody,
  });
}
