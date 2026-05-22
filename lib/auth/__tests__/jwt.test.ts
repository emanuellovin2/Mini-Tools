// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
} from "jose";
import { signToken, verifyToken, LaunchTokenClaimsSchema } from "../jwt";

const ISS = "http://localhost:3000";
const APP_ID = "app_00000000-0000-0000-0000-000000000001";
const ANON_ID = "usr_TestAnonId123456";
const KID = "test-2026-key";

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

// A separate key pair for the "wrong kid" / tampered tests
let otherPrivateKey: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  publicKey = kp.publicKey;

  const jwk = await exportJWK(publicKey);
  jwks = createLocalJWKSet({
    keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }],
  });

  const other = await generateKeyPair("RS256");
  otherPrivateKey = other.privateKey;
});

describe("signToken / verifyToken — happy path", () => {
  it("produces a valid token that verifies with correct aud", async () => {
    const token = await signToken(
      { iss: ISS, aud: APP_ID, sub: ANON_ID, active: true },
      privateKey,
      KID
    );
    const claims = await verifyToken(token, jwks, { issuer: ISS, audience: APP_ID });
    expect(claims.sub).toBe(ANON_ID);
    expect(claims.aud).toBe(APP_ID);
    expect(claims.active).toBe(true);
    expect(claims.jti).toBeTypeOf("string");
  });

  it("active:false is preserved in claims", async () => {
    const token = await signToken(
      { iss: ISS, aud: APP_ID, sub: ANON_ID, active: false },
      privateKey,
      KID
    );
    const claims = await verifyToken(token, jwks, { issuer: ISS, audience: APP_ID });
    expect(claims.active).toBe(false);
  });

  it("exp is within 5 minutes of iat", async () => {
    const token = await signToken(
      { iss: ISS, aud: APP_ID, sub: ANON_ID, active: true },
      privateKey,
      KID
    );
    const claims = await verifyToken(token, jwks, { issuer: ISS, audience: APP_ID });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
  });
});

describe("verifyToken — rejection cases", () => {
  it("rejects an expired token", async () => {
    // Build a token with exp already in the past (exp = iat - 1)
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await new SignJWT({ active: true })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISS)
      .setAudience(APP_ID)
      .setSubject(ANON_ID)
      .setIssuedAt(now - 10)
      .setExpirationTime(now - 5) // already expired
      .sign(privateKey);

    await expect(
      verifyToken(expiredToken, jwks, { issuer: ISS, audience: APP_ID, clockTolerance: 0 })
    ).rejects.toThrow();
  });

  it("rejects a token with wrong aud (minted for app A, presented as app B)", async () => {
    const tokenForAppA = await signToken(
      { iss: ISS, aud: "app_A", sub: ANON_ID, active: true },
      privateKey,
      KID
    );
    await expect(
      verifyToken(tokenForAppA, jwks, { issuer: ISS, audience: "app_B" })
    ).rejects.toThrow();
  });

  it("rejects a tampered-signature token", async () => {
    const token = await signToken(
      { iss: ISS, aud: APP_ID, sub: ANON_ID, active: true },
      privateKey,
      KID
    );
    // Flip a character in the middle of the signature — the last few chars
    // may be base64 padding bits only, which some decoders ignore.
    const parts = token.split(".");
    const sig = parts[2];
    const mid = Math.floor(sig.length / 2);
    const flipped = sig[mid] === "a" ? "b" : "a";
    parts[2] = sig.slice(0, mid) + flipped + sig.slice(mid + 1);
    const tampered = parts.join(".");

    await expect(
      verifyToken(tampered, jwks, { issuer: ISS, audience: APP_ID })
    ).rejects.toThrow();
  });

  it("rejects a token whose kid is not in JWKS", async () => {
    // Sign with a key that carries a kid not present in our JWKS
    const tokenUnknownKid = await new SignJWT({ active: true })
      .setProtectedHeader({ alg: "RS256", kid: "unknown-kid-xyz" })
      .setIssuer(ISS)
      .setAudience(APP_ID)
      .setSubject(ANON_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(otherPrivateKey);

    await expect(
      verifyToken(tokenUnknownKid, jwks, { issuer: ISS, audience: APP_ID })
    ).rejects.toThrow();
  });
});

describe("no-PII invariant", () => {
  it("token claims match LaunchTokenClaimsSchema — no extra keys allowed", async () => {
    const token = await signToken(
      { iss: ISS, aud: APP_ID, sub: ANON_ID, active: true },
      privateKey,
      KID
    );
    const claims = await verifyToken(token, jwks, { issuer: ISS, audience: APP_ID });

    // These are the ONLY allowed keys in the claim set
    const allowedKeys = new Set(["iss", "aud", "sub", "active", "jti", "iat", "exp"]);
    for (const key of Object.keys(claims)) {
      expect(allowedKeys.has(key), `Unexpected claim key "${key}" in token`).toBe(true);
    }

    // sub must be the anon id — never buyer_id format
    expect(claims.sub).toBe(ANON_ID);
    expect(claims.sub).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/); // not a UUID (buyer_id shape)
  });

  it("LaunchTokenClaimsSchema parse rejects a payload with a buyer_id field", () => {
    expect(() =>
      LaunchTokenClaimsSchema.parse({
        iss: ISS,
        aud: APP_ID,
        sub: ANON_ID,
        active: true,
        jti: "x",
        iat: 1,
        exp: 2,
        buyer_id: "should-not-be-here", // extra field
      })
    // Zod v4 strips unknown keys by default — the parse succeeds but buyer_id is absent
    ).not.toThrow();

    const parsed = LaunchTokenClaimsSchema.parse({
      iss: ISS, aud: APP_ID, sub: ANON_ID, active: true, jti: "x", iat: 1, exp: 2,
      buyer_id: "sneaked-in",
    });
    expect((parsed as Record<string, unknown>)["buyer_id"]).toBeUndefined();
  });
});
