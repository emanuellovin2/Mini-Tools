/**
 * Envelope encryption for provider keys (and connector credentials in #43).
 *
 * Per-record schema:
 *   ciphertext  = base64(IV || AES-256-GCM(plaintext, DEK))
 *   dek_wrapped = base64(IV || AES-256-GCM(DEK, masterKey[key_version]))
 *   key_version = which master key wrapped this DEK
 *
 * Master key rotation only re-wraps DEKs — never re-encrypts all secrets.
 * A compromised master key version is bounded to DEKs wrapped by that version.
 *
 * Env vars:
 *   KEY_VAULT_MASTER_KEYS    JSON object: { "1": "<base64-32-bytes>", "2": "..." }
 *   KEY_VAULT_ACTIVE_VERSION integer string ("1", "2", …)
 */

export interface EncryptedSecret {
  ciphertext: string;   // base64
  dek_wrapped: string;  // base64
  key_version: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getMasterKeys(): Record<string, Uint8Array> {
  const raw = process.env.KEY_VAULT_MASTER_KEYS;
  if (!raw) throw new Error("KEY_VAULT_MASTER_KEYS is not set");
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("KEY_VAULT_MASTER_KEYS is not valid JSON");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([v, b64]) => {
      const buf = Buffer.from(b64, "base64");
      if (buf.length !== 32) throw new Error(`Master key version ${v} must be 32 bytes`);
      return [v, new Uint8Array(buf)];
    })
  );
}

function getActiveVersion(): string {
  const v = process.env.KEY_VAULT_ACTIVE_VERSION;
  if (!v) throw new Error("KEY_VAULT_ACTIVE_VERSION is not set");
  return v;
}

function getMasterKey(version: string): Uint8Array {
  const keys = getMasterKeys();
  const key = keys[version];
  if (!key) throw new Error(`Master key version "${version}" not found in KEY_VAULT_MASTER_KEYS`);
  return key;
}

async function aesgcmEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Ensure pure ArrayBuffer inputs for subtle.crypto (no SharedArrayBuffer)
  const keyBuf = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey("raw", keyBuf, "AES-GCM", false, ["encrypt"]);
  const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
  const ptBuf = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer;
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(ivBuf) }, cryptoKey, ptBuf);
  // Layout: [12 bytes IV][ciphertext + 16-byte auth tag]
  const combined = Buffer.concat([Buffer.from(iv), Buffer.from(ciphertext)]);
  return combined.toString("base64");
}

async function aesgcmDecrypt(key: Uint8Array, b64: string): Promise<Uint8Array> {
  const data = Buffer.from(b64, "base64");
  const iv = new Uint8Array(data.subarray(0, 12));
  const ct = new Uint8Array(data.subarray(12));
  const keyBuf = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey("raw", keyBuf, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
  return new Uint8Array(plaintext);
}

// ---------------------------------------------------------------------------
// Public API — reused by #43 connector vault
// ---------------------------------------------------------------------------

/** Encrypt a plaintext secret and return the sealed envelope. */
export async function encryptSecret(plaintext: string): Promise<EncryptedSecret> {
  const version = getActiveVersion();
  const masterKey = getMasterKey(version);

  const dek = crypto.getRandomValues(new Uint8Array(32));
  const ciphertext = await aesgcmEncrypt(dek, new TextEncoder().encode(plaintext));
  const dek_wrapped = await aesgcmEncrypt(masterKey, dek);

  return { ciphertext, dek_wrapped, key_version: parseInt(version, 10) };
}

/** Decrypt a sealed envelope back to plaintext. */
export async function decryptSecret(record: EncryptedSecret): Promise<string> {
  const masterKey = getMasterKey(record.key_version.toString());
  const dek = await aesgcmDecrypt(masterKey, record.dek_wrapped);
  const plaintext = await aesgcmDecrypt(dek, record.ciphertext);
  return new TextDecoder().decode(plaintext);
}

/**
 * Re-wraps all DEKs in `provider_keys` from any old master key version to the
 * current active version. Safe to run online: reads old, writes new version.
 * Old master key stays in KEY_VAULT_MASTER_KEYS until all rows are migrated.
 */
export async function rotateMasterKey(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any
): Promise<{ rotated: number }> {
  const activeVersion = parseInt(getActiveVersion(), 10);

  const { data: keys, error } = await admin
    .from("provider_keys")
    .select("id, dek_wrapped, key_version")
    .neq("key_version", activeVersion);

  if (error) throw new Error(`rotateMasterKey: ${error.message}`);

  let rotated = 0;
  for (const row of keys ?? []) {
    const oldMasterKey = getMasterKey(row.key_version.toString());
    const newMasterKey = getMasterKey(activeVersion.toString());

    const dek = await aesgcmDecrypt(oldMasterKey, row.dek_wrapped);
    const newDekWrapped = await aesgcmEncrypt(newMasterKey, dek);

    const { error: updErr } = await admin
      .from("provider_keys")
      .update({ dek_wrapped: newDekWrapped, key_version: activeVersion })
      .eq("id", row.id);

    if (updErr) throw new Error(`rotateMasterKey: update row ${row.id}: ${updErr.message}`);
    rotated++;
  }

  return { rotated };
}
