import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { upsertNotificationPreference } from "@/lib/services/notifications";
import { z } from "zod";

export const runtime = "nodejs";

const PrefSchema = z.object({
  notif_type:      z.string(),
  in_app_enabled:  z.boolean(),
  email_enabled:   z.boolean(),
  frequency:       z.enum(["immediate", "daily", "weekly"]).default("immediate"),
});

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = PrefSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  await upsertNotificationPreference({ ...parsed.data, userId: user.id });
  return NextResponse.json({ ok: true });
}
