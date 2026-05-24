import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { triggerExport } from "@/lib/services/export";
import type { ExportScope } from "@/lib/services/export";
import { getActiveOrg } from "@/lib/services/org";

export const runtime = "nodejs";

// POST /api/settings/account/export  body: { scope: ExportScope }
export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const body = await req.json().catch(() => ({}));
  const scope = (body.scope as ExportScope) || null;
  if (!scope) return NextResponse.json({ error: "scope required" }, { status: 400 });

  const activeCtx = await getActiveOrg();

  const result = await triggerExport(
    scope,
    { userId: user.id, orgId: activeCtx.org.id, role: profile?.role ?? "buyer" },
    user.email ?? ""
  );

  if (result.mode === "direct") {
    return new NextResponse(result.csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
      },
    });
  }

  return NextResponse.json({ mode: "async", jobId: result.jobId });
}
