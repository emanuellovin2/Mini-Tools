import {
  SignJWT,
  jwtVerify,
  importPKCS8,
  importSPKI,
  exportJWK,
  createLocalJWKSet,
  type JWTPayload,
} from "jose";
import { z } from "zod";

// Zod schema for the claims we mint — guards against PII leakage in tests and responses.
export const LaunchTokenClaimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),           // app_id
  sub: z.string(),           // anon_user_id — opaque, never buyer_id
  active: z.boolean(),
  jti: z.string(),
  iat: z.number(),
  exp: z.number(),
});
export type LaunchTokenClaims = z.infer<typeof LaunchTokenClaimsSchema>;

const TOKEN_TTL_SECONDS = 300; // 5 minutes — SPEC §6

// ---------------------------------------------------------------------------
// Low-level helpers (accept resolved keys — used directly in tests)
// ---------------------------------------------------------------------------

export async function signToken(
  payload: Omit<LaunchTokenClaims, "iat" | "exp" | "jti">,
  privateKey: CryptoKey,
  kid: string
): Promise<string> {
  const { randomUUID } = await import("crypto");
  return new SignJWT({ active: payload.active } as JWTPayload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(payload.iss)
    .setAudience(payload.aud)
    .setSubject(payload.sub)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}

type JwkSet = ReturnType<typeof createLocalJWKSet>;

export async function verifyToken(
  token: string,
  jwks: JwkSet,
  options: { issuer: string; audience: string; clockTolerance?: number }
): Promise<LaunchTokenClaims> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: options.issuer,
    audience: options.audience,
    clockTolerance: options.clockTolerance ?? 30,
  });
  return LaunchTokenClaimsSchema.parse({
    iss: payload.iss,
    aud: payload.aud,
    sub: payload.sub,
    active: payload["active"],
    jti: payload.jti,
    iat: payload.iat,
    exp: payload.exp,
  });
}

// ---------------------------------------------------------------------------
// Env-based helpers (used by production routes)
// ---------------------------------------------------------------------------

function parsePem(raw: string): string {
  // Env vars escape literal newlines as \n — unescape before passing to jose.
  return raw.replace(/\\n/g, "\n");
}

let _privateKey: CryptoKey | null = null;
export async function getPrivateKey(): Promise<CryptoKey> {
  if (_privateKey) return _privateKey;
  const pem = parsePem(process.env.JWT_PRIVATE_KEY!);
  _privateKey = await importPKCS8(pem, "RS256");
  return _privateKey;
}

let _publicKey: CryptoKey | null = null;
export async function getPublicKey(): Promise<CryptoKey> {
  if (_publicKey) return _publicKey;
  const pem = parsePem(process.env.JWT_PUBLIC_KEY!);
  _publicKey = await importSPKI(pem, "RS256");
  return _publicKey;
}

export async function buildJwks(): Promise<{ keys: object[] }> {
  const publicKey = await getPublicKey();
  const kid = process.env.JWT_KEY_ID!;
  const jwk = await exportJWK(publicKey);
  // One entry per configured key. Add a second key here on rotation
  // (no other code changes needed — verifyToken uses createLocalJWKSet which picks by kid).
  return { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] };
}

export async function getJwks(): Promise<JwkSet> {
  const jwks = await buildJwks();
  return createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
}

// High-level mint — reads keys + issuer from env.
export async function mintLaunchToken(
  anonUserId: string,
  appId: string,
  active: boolean
): Promise<string> {
  const [privateKey] = await Promise.all([getPrivateKey()]);
  const kid = process.env.JWT_KEY_ID!;
  const iss = process.env.NEXT_PUBLIC_APP_URL!;
  return signToken({ iss, aud: appId, sub: anonUserId, active }, privateKey, kid);
}
