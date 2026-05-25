import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getActiveOrg } from "@/lib/services/org";
import { getAgencyHealthBoard } from "@/lib/services/agency";

export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { org } = await getActiveOrg();
  if (org.type !== "agency") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const cursor = sp.get("cursor") ?? undefined;
  const limit = Math.min(parseInt(sp.get("limit") ?? "25", 10), 100);

  const page = await getAgencyHealthBoard(org.id, limit, cursor);
  return NextResponse.json(page);
}
