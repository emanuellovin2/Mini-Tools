import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createServerSupabaseClient();
  const { data: { user, session } } = await supabase.auth.getUser()
    .then(async (u) => ({
      data: { user: u.data.user, session: (await supabase.auth.getSession()).data.session },
    }));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Supabase exposes session list via the admin API (service role)
  // In the browser SDK this is not directly available; return current session only
  return NextResponse.json({
    sessions: session
      ? [{
          id: session.access_token.slice(-8),
          created_at: new Date(session.expires_at ? session.expires_at * 1000 - 3600_000 : Date.now()).toISOString(),
          updated_at: new Date().toISOString(),
          user_agent: null,
          ip: null,
        }]
      : [],
    currentId: session?.access_token.slice(-8) ?? null,
  });
}
