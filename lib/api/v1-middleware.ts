/**
 * /api/v1/* middleware helpers.
 *
 * Every handler:
 * 1. Validates Bearer token → resolves org + scopes.
 * 2. Checks required scope.
 * 3. Handles Idempotency-Key header for mutating methods.
 * 4. Blocks irreversible side-effects when mode=test.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  validateApiKey,
  checkIdempotencyKey,
  storeIdempotencyKey,
  type ValidatedKey,
} from "@/lib/services/api-keys";
import { checkRateLimit } from "@/lib/utils/rate-limit";

export interface V1Context {
  org: ValidatedKey;
  isTest: boolean;
}

export async function withV1Auth(
  req: NextRequest,
  requiredScope: string,
  handler: (ctx: V1Context) => Promise<NextResponse>
): Promise<NextResponse> {
  // Rate-limit by IP
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const allowed = await checkRateLimit(`v1:${ip}`, 120, 60);
  if (!allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  // Auth
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer "))
    return NextResponse.json({ error: "missing_auth" }, { status: 401 });
  const rawKey = auth.slice(7);
  const key = await validateApiKey(rawKey);
  if (!key) return NextResponse.json({ error: "invalid_key" }, { status: 401 });
  if (!key.scopes.includes(requiredScope))
    return NextResponse.json({ error: "insufficient_scope", required: requiredScope }, { status: 403 });

  const ctx: V1Context = { org: key, isTest: key.mode === "test" };

  // Idempotency for mutating methods
  const idempotencyKey = req.headers.get("idempotency-key");
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && idempotencyKey) {
    const bodyText = await req.text();
    const requestHash = await sha256Hex(`${req.method}:${req.nextUrl.pathname}:${bodyText}`);

    const check = await checkIdempotencyKey(key.orgId, idempotencyKey, requestHash);
    if (check.cached) {
      return NextResponse.json(check.record.response_body, { status: check.record.response_status });
    }
    if (check.conflict) {
      return NextResponse.json(
        { error: "idempotency_key_conflict", message: "Same key, different request body" },
        { status: 409 }
      );
    }

    // Run handler, cache response
    const res = await handler(ctx);
    const resBody = await res.json().catch(() => null);
    await storeIdempotencyKey(key.orgId, idempotencyKey, requestHash, res.status, resBody);
    return NextResponse.json(resBody, { status: res.status });
  }

  return handler(ctx);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
