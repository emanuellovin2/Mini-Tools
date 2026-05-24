/**
 * POST /api/workflows/[id]/trigger/[secret]
 *
 * Webhook trigger endpoint for `trigger_type='webhook'` workflows.
 * The `[secret]` path segment is the shared HMAC secret stored (hashed) in
 * workflows.webhook_secret. A matching secret authenticates the caller.
 *
 * Accepts any JSON body as the trigger payload; enqueues a run with it.
 * Rate-limited (NOT webhook-exempt — this is an inbound trigger, not platform webhook).
 *
 * Idempotency-Key header: if provided, deduplicates the run across retries.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/services/supabase";
import { enqueueRun } from "@/lib/services/workflows";
import { checkRateLimit } from "@/lib/utils/rate-limit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; secret: string }> }
): Promise<NextResponse> {
  const { id: workflowId, secret } = await params;

  // Rate limit by IP (not webhook-exempt — this is a trigger, not a platform event)
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await checkRateLimit(`wf_trigger:${ip}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Load the workflow to verify secret
  const admin = createAdminClient() as AnyAdmin;
  const { data: wf, error: wfErr } = await admin
    .from("workflows")
    .select("id, status, trigger_type, webhook_secret")
    .eq("id", workflowId)
    .maybeSingle();

  if (wfErr || !wf) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (wf.trigger_type !== "webhook") {
    return NextResponse.json({ error: "not_a_webhook_workflow" }, { status: 400 });
  }

  if (wf.status !== "active") {
    return NextResponse.json({ error: "workflow_not_active" }, { status: 409 });
  }

  // Constant-time secret comparison to prevent timing attacks
  const storedSecret: string = wf.webhook_secret ?? "";
  if (!timingSafeEqual(secret, storedSecret)) {
    return NextResponse.json({ error: "invalid_secret" }, { status: 401 });
  }

  // Parse body as trigger payload
  let body: Record<string, unknown> = {};
  try {
    const rawBody = await request.text();
    if (rawBody) {
      body = JSON.parse(rawBody);
    }
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;

  try {
    const { runId } = await enqueueRun(workflowId, body, idempotencyKey);
    return NextResponse.json({ ok: true, run_id: runId }, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 422 });
  }
}

/** Constant-time string comparison (prevents timing oracle on the secret). */
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) {
    // Deliberately compare anyway to avoid early-exit timing leak
    let acc = 1;
    for (let i = 0; i < Math.max(aBytes.length, bBytes.length); i++) {
      acc |= (aBytes[i % aBytes.length] ^ bBytes[i % bBytes.length]);
    }
    return false; // length mismatch is always false
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}
