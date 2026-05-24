import { NextRequest, NextResponse } from "next/server";
import { withV1Auth } from "@/lib/api/v1-middleware";
import { createAdminClient } from "@/lib/services/supabase";

export const runtime = "nodejs";

// GET /api/v1/subscriptions — list subscriptions for the caller's apps
export async function GET(req: NextRequest) {
  return withV1Auth(req, "read:analytics", async (ctx) => {
    const url = req.nextUrl;
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100"), 1000);
    const offset = parseInt(url.searchParams.get("offset") ?? "0");

    const admin = createAdminClient();

    // Join through apps to scope to this vendor's org
    const { data, error, count } = await admin
      .from("subscriptions")
      .select(
        "id, status, price_cents, created_at, cancel_at_period_end, affiliate_id, reseller_id, apps!inner(vendor_id)",
        { count: "exact" }
      )
      .eq("apps.vendor_id", ctx.org.orgId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Strip apps join from response; never expose buyer_id
    const rows = (data ?? []).map(({ apps: _apps, ...row }) => row);
    return NextResponse.json({ data: rows, total: count ?? 0, limit, offset });
  });
}
