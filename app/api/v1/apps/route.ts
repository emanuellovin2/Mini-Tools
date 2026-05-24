import { NextRequest, NextResponse } from "next/server";
import { withV1Auth } from "@/lib/api/v1-middleware";
import { createAdminClient } from "@/lib/services/supabase";

export const runtime = "nodejs";

// GET /api/v1/apps — list the caller org's apps
export async function GET(req: NextRequest) {
  return withV1Auth(req, "manage:products", async (ctx) => {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("apps")
      .select("id, name, slug, status, price_cents, min_price_cents, created_at")
      .eq("vendor_id", ctx.org.orgId)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data ?? [] });
  });
}
