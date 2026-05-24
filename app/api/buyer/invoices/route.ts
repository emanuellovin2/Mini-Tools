import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { getBuyerInvoices } from "@/lib/services/buyer";

export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "buyer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Verify the customerId belongs to this buyer
  const customerId = req.nextUrl.searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ error: "Missing customerId" }, { status: 400 });

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id")
    .eq("buyer_id", user.id)
    .eq("stripe_customer_id", customerId)
    .limit(1)
    .maybeSingle();

  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await getBuyerInvoices(customerId, { limit: 20 });
  return NextResponse.json(result);
}
