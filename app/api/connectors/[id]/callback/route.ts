/**
 * GET /api/connectors/[id]/callback
 *
 * OAuth2 callback: exchanges the authorization code, encrypts tokens, stores
 * the account, then redirects the user to the connections settings page.
 *
 * The state param is HMAC-SHA256 signed; forged/expired states are rejected.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { handleOAuthCallback } from "@/lib/services/connectors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: connectorId } = await params;

  // Validate session (the provider redirected back to us; the user must be logged in)
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
    return NextResponse.redirect(
      `${appUrl}/account/connections?error=${encodeURIComponent(error)}`
    );
  }

  if (!code || !state) {
    return NextResponse.json(
      { error: "missing_params", message: "code and state are required" },
      { status: 400 }
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const redirectUri = `${appUrl}/api/connectors/${connectorId}/callback`;

  try {
    const { accountId } = await handleOAuthCallback(connectorId, code, state, redirectUri);
    return NextResponse.redirect(
      `${appUrl}/account/connections?connected=${encodeURIComponent(connectorId)}&account_id=${accountId}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(
      JSON.stringify({ event: "connector.oauth_callback_failed", connector: connectorId, error: msg })
    );
    return NextResponse.redirect(
      `${appUrl}/account/connections?error=${encodeURIComponent(msg)}`
    );
  }
}
