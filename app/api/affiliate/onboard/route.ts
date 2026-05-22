import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getOrCreateConnectAccount, createOnboardingLink } from "@/lib/stripe/connect";

export async function GET(): Promise<NextResponse> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "affiliate") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const accountId = await getOrCreateConnectAccount(user.id);
  const url = await createOnboardingLink(
    accountId,
    `${appUrl}/affiliate?onboard=success`,
    `${appUrl}/affiliate?onboard=refresh`
  );

  return NextResponse.redirect(url);
}
