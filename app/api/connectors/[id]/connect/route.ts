/**
 * GET /api/connectors/[id]/connect
 *
 * Initiates OAuth2 consent for a connector.
 * Requires an authenticated session (Supabase cookie).
 *
 * Query params:
 *   org_id   — the org that will own the credential
 *   label    — optional display label (defaults to connector name)
 *
 * Response: 302 redirect to the provider's OAuth consent screen.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { connectAccount } from "@/lib/services/connectors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: connectorId } = await params;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const orgId = req.nextUrl.searchParams.get("org_id");
  if (!orgId) {
    return NextResponse.json(
      { error: "missing_org_id", message: "?org_id is required" },
      { status: 400 }
    );
  }

  const label = req.nextUrl.searchParams.get("label") ?? "";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const redirectUri = `${appUrl}/api/connectors/${connectorId}/callback`;

  try {
    const { authUrl } = await connectAccount(orgId, connectorId, label, redirectUri);
    return NextResponse.redirect(authUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: "connect_failed", message: msg }, { status: 400 });
  }
}
