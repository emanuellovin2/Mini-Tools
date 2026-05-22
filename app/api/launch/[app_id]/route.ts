import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { mintLaunchToken } from "@/lib/auth/jwt";
import { isAccessActive } from "@/lib/stripe/entitlements";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ app_id: string }> }
) {
  const { app_id: appId } = await params;

  // Require authenticated buyer session
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Look up the buyer's subscription — include paused ones so we can return a useful error
  const { data: sub, error } = await admin
    .from("subscriptions")
    .select("anon_user_id, status, paused_until")
    .eq("buyer_id", user.id)
    .eq("app_id", appId)
    .in("status", ["active", "trialing"])
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
  if (!sub) {
    return NextResponse.json({ error: "No active subscription" }, { status: 403 });
  }
  if (!isAccessActive({ status: sub.status, paused_until: sub.paused_until })) {
    return NextResponse.json({ error: "Subscription is paused" }, { status: 403 });
  }

  // Resolve the app's auth_url
  const { data: app } = await admin
    .from("apps")
    .select("auth_url")
    .eq("id", appId)
    .single();

  if (!app?.auth_url) {
    return NextResponse.json({ error: "App has no auth URL configured" }, { status: 422 });
  }

  const active = isAccessActive({ status: sub.status, paused_until: sub.paused_until });
  const token = await mintLaunchToken(sub.anon_user_id, appId, active);

  // Redirect buyer to the vendor app with the token
  const destination = new URL(app.auth_url);
  destination.searchParams.set("token", token);
  return NextResponse.redirect(destination.toString(), 302);
}
