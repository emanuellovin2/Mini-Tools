import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { enqueueJob } from "@/lib/jobs/queue";

export const runtime = "nodejs";

// POST /api/settings/account/delete
// Soft-deletes the user: sets deleted_at on profiles, signs out, enqueues
// a hard-erasure job for 30 days later.
export async function POST() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Soft-delete: mark profile with deleted_at so dashboards can gate access
  await admin
    .from("profiles")
    .update({ deleted_at: new Date().toISOString() } as never)
    .eq("id", user.id);

  // Enqueue hard erasure in 30 days
  await enqueueJob(
    "erasure",
    { userId: user.id },
    {
      idempotencyKey: `erasure:${user.id}`,
      runAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }
  );

  // Sign user out of all sessions
  await supabase.auth.signOut();

  return NextResponse.json({ ok: true });
}
