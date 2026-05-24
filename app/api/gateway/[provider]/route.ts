/**
 * POST /api/gateway/[provider]
 *
 * Streaming AI proxy with reserve-then-settle metering.
 * Auth: Supabase session OR Bearer gateway token (gw_*).
 *
 * Required query params:
 *   ?deployment_id=<uuid>   — scopes the call to a specific deployment
 *
 * Optional headers:
 *   Idempotency-Key   — dedup retries; same key returns cached result, never double-meters
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  resolveAndForward,
  validateGatewayToken,
  GatewayError,
} from "@/lib/services/gateway";

export const runtime = "nodejs";
// Do not buffer the response — we stream it through
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
): Promise<NextResponse | Response> {
  const { provider } = await params;
  if (!["openai", "anthropic", "openai_compat"].includes(provider)) {
    return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
  }

  const deploymentId = req.nextUrl.searchParams.get("deployment_id");
  if (!deploymentId) {
    return NextResponse.json(
      { error: "missing_deployment_id", message: "?deployment_id is required" },
      { status: 400 }
    );
  }

  const idempotencyKey = req.headers.get("idempotency-key") ?? undefined;

  // ---------------------------------------------------------------------------
  // Auth: Supabase session OR gateway token
  // ---------------------------------------------------------------------------
  let buyerId: string;
  let buyerOrgId: string;
  let gatewayToken = null;

  const authHeader = req.headers.get("authorization") ?? "";

  if (authHeader.startsWith("Bearer gw_")) {
    // Gateway token auth
    const rawToken = authHeader.slice(7);
    const validated = await validateGatewayToken(rawToken);
    if (!validated) {
      return NextResponse.json(
        { error: "invalid_token", message: "Gateway token is invalid, revoked, or paused" },
        { status: 401 }
      );
    }
    gatewayToken = validated;
    // For gateway tokens, owner_id is the org; we need buyer_id for metering.
    // Gateway tokens are issued by the buyer's org — use org as proxy for now.
    // Full buyer resolution comes in #44 when token↔subscription linkage lands.
    buyerId = validated.ownerOrgId;
    buyerOrgId = validated.ownerOrgId;
  } else {
    // Supabase session auth
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: "unauthenticated", message: "Authentication required" },
        { status: 401 }
      );
    }

    buyerId = user.id;

    // Resolve user's personal org (or primary org) for metering context
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("org_id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    buyerOrgId = membership?.org_id ?? user.id;
  }

  // ---------------------------------------------------------------------------
  // Parse body
  // ---------------------------------------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // ---------------------------------------------------------------------------
  // Forward via gateway service
  // ---------------------------------------------------------------------------
  try {
    const result = await resolveAndForward({
      buyerId,
      buyerOrgId,
      deploymentId,
      body,
      idempotencyKey,
      gatewayToken,
    });

    // Stream the response back verbatim
    return new Response(result.stream, {
      status: result.status,
      headers: {
        ...result.headers,
        "x-gateway-provider": provider,
      },
    });
  } catch (err) {
    if (err instanceof GatewayError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.status }
      );
    }

    // Log provider errors without body content
    console.error("[gateway] forward error:", {
      provider,
      deploymentId,
      buyerId,
      error: err instanceof Error ? err.message : String(err),
    });

    return NextResponse.json(
      { error: "provider_error", message: "Provider request failed" },
      { status: 502 }
    );
  }
}
