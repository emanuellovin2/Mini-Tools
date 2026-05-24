// Supabase Edge Function — durable job queue tick worker
// Schedule: * * * * *  (every minute)
// Atomically claims up to 10 queued/failed jobs, runs their handlers,
// and marks them succeeded / failed / dead.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WORKER_ID = `worker-${crypto.randomUUID()}`;
const CLAIM_LIMIT = 10;
const LEASE_MS = 5 * 60 * 1000; // 5 min

type JobStatus = "queued" | "running" | "succeeded" | "failed" | "dead";
interface Job {
  id: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  org_id: string | null;
  idempotency_key: string | null;
}

// ── Inline handler registry (Edge Functions cannot import from /lib) ──────────

type Handler = (payload: unknown, ctx: { jobId: string; orgId: string | null }) => Promise<unknown>;
const handlers: Record<string, Handler> = {};

function register(type: string, handler: Handler) {
  handlers[type] = handler;
}

// Erasure stub — #45 will flesh out
register("erasure", async (payload, _ctx) => {
  const { userId } = payload as { userId: string };
  console.log(JSON.stringify({ event: "jobs.erasure", userId }));
  return { status: "stub" };
});

// Export stub — #39 will flesh out
register("export", async (payload, _ctx) => {
  const { exportId } = payload as { exportId: string };
  console.log(JSON.stringify({ event: "jobs.export", exportId }));
  return { status: "stub" };
});

// Outbound webhook delivery
register("webhook_delivery", async (payload, ctx) => {
  const { endpointUrl, eventType, body, secret, deliveryId, orgId } = payload as {
    endpointUrl: string;
    eventType: string;
    body: Record<string, unknown>;
    secret: string;
    deliveryId: string;
    orgId: string;
  };

  const bodyJson = JSON.stringify(body);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(bodyJson));
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

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

  return { statusCode: res.status, ok: res.ok };
});

// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  const now = new Date().toISOString();
  const lockedUntil = new Date(Date.now() + LEASE_MS).toISOString();

  // Atomically claim jobs
  const { data: jobs, error: claimErr } = await supabase.rpc("claim_jobs", {
    p_worker_id: WORKER_ID,
    p_limit: CLAIM_LIMIT,
    p_now: now,
    p_locked_until: lockedUntil,
  });

  if (claimErr) {
    console.error(JSON.stringify({ event: "worker.claim_error", error: claimErr.message }));
    return new Response("error", { status: 500 });
  }

  const claimed = (jobs as Job[]) ?? [];
  console.log(JSON.stringify({ event: "worker.tick", claimed: claimed.length, worker: WORKER_ID }));

  const results = await Promise.allSettled(
    claimed.map(async (job) => {
      const handler = handlers[job.type];
      if (!handler) {
        await failJob(supabase, job.id, `No handler for type: ${job.type}`, job.attempts, job.max_attempts);
        return;
      }
      try {
        const result = await handler(job.payload, { jobId: job.id, orgId: job.org_id });
        await supabase
          .from("jobs")
          .update({ status: "succeeded", result, finished_at: new Date().toISOString(), locked_by: null, locked_until: null })
          .eq("id", job.id);
        console.log(JSON.stringify({ event: "worker.job_succeeded", jobId: job.id, type: job.type }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const retryMs = Math.min(60_000 * 2 ** job.attempts, 3_600_000); // cap at 1h
        await failJob(supabase, job.id, msg, job.attempts, job.max_attempts, retryMs);
        console.error(JSON.stringify({ event: "worker.job_failed", jobId: job.id, type: job.type, error: msg }));
      }
    })
  );

  const failed = results.filter(r => r.status === "rejected").length;
  return new Response(JSON.stringify({ processed: claimed.length, failed }), {
    headers: { "Content-Type": "application/json" },
  });
});

async function failJob(
  supabase: ReturnType<typeof createClient>,
  jobId: string,
  errorMsg: string,
  attempts: number,
  maxAttempts: number,
  retryMs = 60_000
) {
  const isDead = attempts >= maxAttempts;
  await supabase
    .from("jobs")
    .update({
      status: isDead ? "dead" : "failed",
      last_error: errorMsg,
      next_run_at: isDead ? new Date().toISOString() : new Date(Date.now() + retryMs).toISOString(),
      finished_at: isDead ? new Date().toISOString() : null,
      locked_by: null,
      locked_until: null,
    })
    .eq("id", jobId);
}
