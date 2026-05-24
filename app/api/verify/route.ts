import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jwtVerify, errors as joseErrors } from "jose";
import { getJwks } from "@/lib/auth/jwt";
import { createAdminClient } from "@/lib/services/supabase";
import { isAccessActive } from "@/lib/stripe/entitlements";
import { checkRateLimit } from "@/lib/utils/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// The only shape this endpoint ever returns — Zod-asserted, never leaks PII.
const VerifyResponseSchema = z.object({
  user_id: z.string(),  // anon_user_id — opaque, never buyer_id
  active: z.boolean(),
});
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

const BodySchema = z.object({
  token: z.string().min(1),
  app_id: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  // Rate-limit by IP (60 req/min)
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { allowed } = await checkRateLimit(ip, RATE_LIMIT, RATE_WINDOW_MS);
  if (!allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Parse body
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { token, app_id: appId } = body;
  const issuer = process.env.NEXT_PUBLIC_APP_URL!;

  // Verify JWT: signature (via JWKS + kid), exp, iss, aud — clockTolerance 30s
  let sub: string;
  try {
    const jwks = await getJwks();
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: appId,
      clockTolerance: 30,
    });
    if (typeof payload.sub !== "string") throw new Error("Missing sub");
    sub = payload.sub;
  } catch (err) {
    const isExpected =
      err instanceof joseErrors.JWTExpired ||
      err instanceof joseErrors.JWTClaimValidationFailed ||
      err instanceof joseErrors.JWSSignatureVerificationFailed ||
      err instanceof joseErrors.JWSInvalid ||
      err instanceof joseErrors.JWKSNoMatchingKey;
    return NextResponse.json(
      { error: isExpected ? "Invalid token" : "Verification failed" },
      { status: 401 }
    );
  }

  // Live status check — token's `active` is only a 5-min snapshot (SPEC §6)
  const admin = createAdminClient();
  const { data: subRow } = await admin
    .from("subscriptions")
    .select("status, app_id, id, paused_until")
    .eq("anon_user_id", sub)
    .eq("app_id", appId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const active = subRow
    ? isAccessActive({ status: subRow.status, paused_until: subRow.paused_until })
    : false;

  // First successful verify from this app's origin → mark integration connected
  const origin = req.headers.get("origin");
  if (origin && subRow) {
    const { data: app } = await admin
      .from("apps")
      .select("id, auth_url, first_verified_at")
      .eq("id", appId)
      .maybeSingle();

    if (app && !app.first_verified_at && app.auth_url) {
      try {
        const authOrigin = new URL(app.auth_url).origin;
        if (origin === authOrigin) {
          await admin
            .from("apps")
            .update({ first_verified_at: new Date().toISOString() })
            .eq("id", appId);
        }
      } catch {
        // Invalid auth_url — skip silently
      }
    }
  }

  // Zod-assert the response shape so no PII can slip through
  const response = VerifyResponseSchema.parse({ user_id: sub, active });
  return NextResponse.json(response);
}
