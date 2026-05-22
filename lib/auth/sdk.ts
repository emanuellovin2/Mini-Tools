/**
 * @platform/auth — vendor-side token verification helper
 *
 * Quickstart:
 *   1. Set PLATFORM_JWKS_URL to https://<platform-domain>/.well-known/jwks.json
 *   2. Set PLATFORM_APP_ID to your app's id (from the vendor dashboard)
 *   3. Call verifyPlatformToken(token, { jwksUrl, appId }) in your auth handler
 *   4. Start a session keyed on result.userId — never store buyer PII
 *
 * Example (Express):
 *   app.get("/auth", async (req, res) => {
 *     const result = await verifyPlatformToken(req.query.token, {
 *       jwksUrl: process.env.PLATFORM_JWKS_URL,
 *       appId:   process.env.PLATFORM_APP_ID,
 *     });
 *     if (!result.active) return res.status(403).send("Subscription inactive");
 *     req.session.userId = result.userId;
 *     res.redirect("/dashboard");
 *   });
 */

import { jwtVerify, createRemoteJWKSet } from "jose";
import { z } from "zod";

const ResultSchema = z.object({
  userId: z.string(),
  active: z.boolean(),
});
export type VerifyResult = z.infer<typeof ResultSchema>;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyPlatformToken(
  token: string,
  options: {
    jwksUrl: string;
    appId: string;
    issuer?: string;
    clockTolerance?: number;
  }
): Promise<VerifyResult> {
  if (!jwksCache.has(options.jwksUrl)) {
    jwksCache.set(options.jwksUrl, createRemoteJWKSet(new URL(options.jwksUrl)));
  }
  const JWKS = jwksCache.get(options.jwksUrl)!;

  const { payload } = await jwtVerify(token, JWKS, {
    audience: options.appId,
    ...(options.issuer ? { issuer: options.issuer } : {}),
    clockTolerance: options.clockTolerance ?? 30,
  });

  return ResultSchema.parse({
    userId: payload.sub,
    active: payload["active"],
  });
}
