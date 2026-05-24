import { NextRequest, NextResponse } from "next/server";
import { withV1Auth } from "@/lib/api/v1-middleware";
import { createAdminClient } from "@/lib/services/supabase";

export const runtime = "nodejs";

// GET /api/v1/analytics — aggregate analytics for the caller's org
// Query params: days (default 30, max 90)
export async function GET(req: NextRequest) {
  return withV1Auth(req, "read:analytics", async (ctx) => {
    const days = Math.min(parseInt(req.nextUrl.searchParams.get("days") ?? "30"), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from("analytics_daily")
      .select("date, event_type, entity_type, entity_id, total_events, unique_visitors")
      .eq("owner_org_id", ctx.org.orgId)
      .gte("date", since)
      .order("date", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data ?? [], days });
  });
}
