import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  listVendorWebhooks,
  createVendorWebhook,
} from "@/lib/services/vendor-webhooks";
import { getActiveOrg } from "@/lib/services/org";
import { enforceQuota } from "@/lib/quotas/enforce";
import { z } from "zod";

export const runtime = "nodejs";

const CreateSchema = z.object({
  url: z.string().url().startsWith("https://"),
  events: z.array(z.string()).min(1),
  app_id: z.string().uuid().optional(),
});

export async function GET() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const webhooks = await listVendorWebhooks();
  return NextResponse.json(webhooks);
}

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "vendor")
    return NextResponse.json({ error: "Vendor only" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const activeCtx = await getActiveOrg();

  // Quota guard — every new creatable resource must enforce quota
  await enforceQuota(activeCtx.org.id, "webhook_endpoints");

  const { webhook, signingSecret } = await createVendorWebhook({
    vendorId: user.id,
    orgId: activeCtx.org.id,
    url: parsed.data.url,
    events: parsed.data.events,
    appId: parsed.data.app_id,
  });

  return NextResponse.json({ webhook, signingSecret }, { status: 201 });
}
