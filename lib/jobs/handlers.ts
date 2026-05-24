import type { Job } from "./queue";

export interface JobContext {
  workerId: string;
  jobId: string;
  orgId: string | null;
}

export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<unknown>;

// Handler registry — each job type registers exactly one handler.
// Handlers must be idempotent: retries must be safe.
const handlers: Record<string, JobHandler> = {};

export function registerHandler(type: string, handler: JobHandler): void {
  if (handlers[type]) throw new Error(`Handler already registered for job type: ${type}`);
  handlers[type] = handler;
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers[type];
}

export async function runJob(job: Job, workerId: string): Promise<unknown> {
  const handler = handlers[job.type];
  if (!handler) throw new Error(`No handler registered for job type: ${job.type}`);
  return handler(job.payload, { workerId, jobId: job.id, orgId: job.org_id });
}

// ── Built-in handlers ────────────────────────────────────────────────────────

// Churn alert email — sends a churn notice + records an audit_log row.
// Enqueued by dispatchChurnAlerts; one job per (vendor, month).
registerHandler("churn_alert_email", async (payload, _ctx) => {
  const {
    vendorId,
    vendorName,
    rateBps,
    canceled,
    activeAtStart,
    month,
  } = payload as {
    vendorId: string;
    vendorName: string | null;
    rateBps: number;
    canceled: number;
    activeAtStart: number;
    month: string;
  };

  const [{ sendChurnAlert }, { createAdminClient }] = await Promise.all([
    import("@/lib/email/resend"),
    import("@/lib/services/supabase"),
  ]);

  await sendChurnAlert({ vendorName, vendorId, rateBps, canceled, activeAtStart, month });

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: null,
    actor_role: "system",
    action: "churn.alert_sent",
    entity_type: "profiles",
    entity_id: vendorId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata: { month, rate_bps: rateBps } as any,
  });

  return { vendorId, month };
});

// Stub: erasure fan-out (#45 will populate)
registerHandler("erasure", async (payload, _ctx) => {
  const { userId } = payload as { userId: string };
  console.log(JSON.stringify({ event: "jobs.erasure.stub", userId }));
  return { status: "stub" };
});

// Stub: data export (#39 will populate)
registerHandler("export", async (payload, _ctx) => {
  const { exportId } = payload as { exportId: string };
  console.log(JSON.stringify({ event: "jobs.export.stub", exportId }));
  return { status: "stub" };
});

// Outbound webhook delivery (#39 §5 will wire real endpoints table)
registerHandler("webhook_delivery", async (payload, ctx) => {
  const {
    endpointUrl,
    eventType,
    body,
    secret,
    deliveryId,
    orgId,
  } = payload as {
    endpointUrl: string;
    eventType: string;
    body: Record<string, unknown>;
    secret: string;
    deliveryId: string;
    orgId: string;
  };

  const bodyJson = JSON.stringify(body);
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(bodyJson);

  // HMAC-SHA256 signature
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const res = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Platform-Signature": `sha256=${sigHex}`,
      "X-Event-Type": eventType,
      "X-Delivery-Id": deliveryId,
    },
    body: bodyJson,
    signal: AbortSignal.timeout(10_000),
  });

  // Record delivery attempt — cast via any since vendor_webhook_deliveries not
  // yet in generated types (run `npm run types` after migrations apply).
  const { createAdminClient } = await import("@/lib/services/supabase");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  await admin.from("vendor_webhook_deliveries").insert({
    job_id: ctx.jobId,
    org_id: orgId,
    endpoint_url: endpointUrl,
    event_type: eventType,
    payload: body,
    status_code: res.status,
    response_body: (await res.text()).slice(0, 500),
    delivered_at: res.ok ? new Date().toISOString() : null,
  });

  if (!res.ok) throw new Error(`webhook_delivery: HTTP ${res.status}`);
  return { statusCode: res.status };
});
