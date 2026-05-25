import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { debugRetrieve } from "@/lib/services/knowledge";

// Admin/dev only — returns raw retrieval results for relevance tuning
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.KNOWLEDGE_ENABLED !== "true") {
    return NextResponse.json({ error: "knowledge_disabled" }, { status: 404 });
  }

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Admin only
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if ((profile as { role: string } | null)?.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json()) as {
    orgId: string;
    baseId: string;
    query: string;
    topK?: number;
  };

  if (!body.orgId || !body.baseId || !body.query) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const result = await debugRetrieve({
    orgId: body.orgId,
    baseId: body.baseId,
    query: body.query,
    topK: body.topK ?? 10,
    plaintextApiKey: process.env.OPENAI_API_KEY,
  });

  return NextResponse.json(result);
}
