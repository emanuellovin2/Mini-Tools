import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { getAuditLog } from "@/lib/services/admin";

export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const p = req.nextUrl.searchParams;
  const { entries } = await getAuditLog({
    actorId: p.get("actor_id") || undefined,
    entityType: p.get("entity_type") || undefined,
    since: p.get("since") || undefined,
    until: p.get("until") || undefined,
    pageSize: 5000,
  });

  const header = "id,created_at,actor_id,actor_role,action,entity_type,entity_id\n";
  const rows = entries.map((e) =>
    [e.id, e.created_at, e.actor_id ?? "", e.actor_role ?? "", e.action, e.entity_type, e.entity_id ?? ""]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  const csv = header + rows.join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
