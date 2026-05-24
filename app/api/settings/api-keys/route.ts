import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createApiKey, listApiKeys } from "@/lib/services/api-keys";
import { getActiveOrg } from "@/lib/services/org";
import { enforceQuota } from "@/lib/quotas/enforce";
import { z } from "zod";

export const runtime = "nodejs";

const CreateSchema = z.object({
  name:   z.string().min(1).max(64),
  mode:   z.enum(["test", "live"]),
  scopes: z.array(z.string()).min(1),
});

export async function GET() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const activeCtx = await getActiveOrg();
  const keys = await listApiKeys(activeCtx.org.id);
  return NextResponse.json(keys);
}

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const activeCtx = await getActiveOrg();
  await enforceQuota(activeCtx.org.id, "api_keys");

  const { key, plaintext } = await createApiKey({
    orgId: activeCtx.org.id,
    name: parsed.data.name,
    mode: parsed.data.mode,
    scopes: parsed.data.scopes as import("@/lib/services/api-keys").ApiKeyScope[],
  });

  return NextResponse.json({ key, plaintext }, { status: 201 });
}
