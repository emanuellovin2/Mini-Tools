import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { syncConnectStatus } from "@/lib/stripe/connect";

export const runtime = "nodejs";

export async function POST() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, stripe_account_id")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "vendor") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!profile.stripe_account_id) {
    return NextResponse.json({ error: "No Stripe account linked yet" }, { status: 400 });
  }

  try {
    const status = await syncConnectStatus(user.id, profile.stripe_account_id);
    return NextResponse.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
