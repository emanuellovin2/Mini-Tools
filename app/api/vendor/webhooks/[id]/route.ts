import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import {
  updateVendorWebhook,
  deleteVendorWebhook,
  rotateSigningSecret,
} from "@/lib/services/vendor-webhooks";
import { z } from "zod";

export const runtime = "nodejs";

const PatchSchema = z.object({
  url:     z.string().url().startsWith("https://").optional(),
  events:  z.array(z.string()).min(1).optional(),
  enabled: z.boolean().optional(),
  app_id:  z.string().uuid().nullable().optional(),
  rotate_secret: z.boolean().optional(),
});

async function requireVendor(id?: string) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 };
  const { data: p } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (p?.role !== "vendor") return { error: "Vendor only", status: 403 };
  return { user, id };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireVendor(id);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json().catch(() => ({}));
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { rotate_secret, ...patch } = parsed.data;

  if (Object.keys(patch).length > 0) {
    await updateVendorWebhook(id, {
      url: patch.url,
      events: patch.events,
      enabled: patch.enabled,
      appId: patch.app_id,
    });
  }

  if (rotate_secret) {
    const { signingSecret } = await rotateSigningSecret(id);
    return NextResponse.json({ ok: true, signingSecret });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireVendor(id);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  await deleteVendorWebhook(id);
  return NextResponse.json({ ok: true });
}
