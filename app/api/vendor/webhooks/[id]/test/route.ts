import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";

export const runtime = "nodejs";

// POST /api/vendor/webhooks/[id]/test
// Dispatches a test event to the endpoint immediately (not via job queue).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: hook } = await (admin as any)
    .from("vendor_webhooks")
    .select("id, url, signing_secret, events, vendor_id")
    .eq("id", id)
    .eq("vendor_id", user.id)
    .single();

  if (!hook) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = JSON.stringify({
    event: "v1.test",
    test: true,
    timestamp: new Date().toISOString(),
  });

  const encoder = new TextEncoder();
  const keyData = encoder.encode(hook.signing_secret as string);
  const msgData = encoder.encode(body);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  let status = 0;
  let ok = false;
  try {
    const res = await fetch(hook.url as string, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Platform-Signature": `sha256=${sigHex}`,
        "X-Event-Type": "v1.test",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    ok = res.ok;
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ ok, status });
}
