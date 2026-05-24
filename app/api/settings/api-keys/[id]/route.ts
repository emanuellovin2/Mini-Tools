import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { revokeApiKey } from "@/lib/services/api-keys";

export const runtime = "nodejs";

// DELETE /api/settings/api-keys/[id]  — revoke immediately
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await revokeApiKey(id);
  return NextResponse.json({ ok: true });
}
