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

// Legacy erasure stub — kept for backward compatibility with pre-#45 job rows.
// New erasure jobs are dispatched as partner_client_erasure_hard.
registerHandler("erasure", async (_payload, _ctx) => {
  return { status: "stub" };
});

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

// ── #45: partner client export ──────────────────────────────────────────────
// Assembles a JSON dump of all data held for a partner client and marks the
// request as completed. Partners receive a download link (stub: logs URL).
registerHandler("partner_client_export", async (payload, _ctx) => {
  const { partnerOwnerId, partnerClientId, requestId } = payload as {
    partnerOwnerId: string;
    partnerClientId: string;
    requestId: string;
  };

  const { createAdminClient } = await import("@/lib/services/supabase");
  const { writeAuditLog } = await import("@/lib/services/admin");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // Assemble all stores scoped to this client
  const [clientRow, usageEvents, workflowRuns] = await Promise.all([
    admin.from("partner_clients").select("*").eq("id", partnerClientId).maybeSingle(),
    admin.from("usage_events").select("id, created_at, quantity, unit").eq("partner_client_id", partnerClientId),
    admin.from("workflow_runs").select("id, created_at, status, workflow_id").eq("partner_client_id", partnerClientId),
  ]);

  const exportPayload = {
    exported_at: new Date().toISOString(),
    partner_owner_id: partnerOwnerId,
    client: clientRow.data ?? null,
    usage_events: usageEvents.data ?? [],
    workflow_runs: workflowRuns.data ?? [],
  };

  // In production, upload to Supabase Storage and store signed URL.
  // For now, log the payload size and mark complete.
  const payloadSize = JSON.stringify(exportPayload).length;
  console.log(JSON.stringify({ event: "partner_client_export.assembled", partnerClientId, bytes: payloadSize }));

  await admin
    .from("partner_data_requests")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", requestId);

  await writeAuditLog({
    actorId: null,
    actorRole: "system",
    action: "partner_client.export_completed",
    entityType: "partner_client",
    entityId: partnerClientId,
    metadata: { request_id: requestId, bytes: payloadSize },
  });

  return { partnerClientId, requestId, bytes: payloadSize };
});

// ── #45: partner client hard erasure ────────────────────────────────────────
// Fans out hard erasure across all registered stores after the grace window.
// Idempotent: erasers null/delete already-null columns safely.
registerHandler("partner_client_erasure_hard", async (payload, _ctx) => {
  const { partnerClientId, requestId } = payload as {
    partnerClientId: string;
    requestId: string;
  };

  const { runErasure } = await import("@/lib/services/privacy");
  await runErasure(partnerClientId, requestId);

  console.log(JSON.stringify({ event: "partner_client_erasure_hard.completed", partnerClientId, requestId }));
  return { partnerClientId, requestId };
});

// Data export — runs the scoped query and emails a CSV download link.
registerHandler("export", async (payload, _ctx) => {
  const { scope, userId, orgId, role, emailTo } = payload as {
    scope: string;
    userId: string;
    orgId: string;
    role: string;
    emailTo: string;
  };

  const [{ runExportDirect }, { sendExportReady }] = await Promise.all([
    import("@/lib/services/export"),
    import("@/lib/email/resend"),
  ]);

  const { csv, filename } = await runExportDirect(
    scope as import("@/lib/services/export").ExportScope,
    { userId, orgId, role }
  );

  await sendExportReady({ to: emailTo, filename, csv });
  return { scope, rows: csv.split("\n").length - 1 };
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
    webhookId,
  } = payload as {
    endpointUrl: string;
    eventType: string;
    body: Record<string, unknown>;
    secret: string;
    deliveryId: string;
    orgId: string;
    webhookId?: string;
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

  if (!res.ok) {
    if (webhookId) {
      const { recordWebhookFailure } = await import("@/lib/services/vendor-webhooks");
      await recordWebhookFailure(webhookId).catch(() => {});
    }
    throw new Error(`webhook_delivery: HTTP ${res.status}`);
  }

  if (webhookId) {
    const { recordWebhookSuccess } = await import("@/lib/services/vendor-webhooks");
    await recordWebhookSuccess(webhookId).catch(() => {});
  }

  return { statusCode: res.status };
});

// ── #51: outcome metrics emit batch (volume_class='high') ───────────────────
// Payload: array of EmitMetricInput rows enqueued by emitMetric() for high-volume solutions.
// Batch-inserts up to 1000 rows at a time; remaining rows stay in queue via retry.
registerHandler("outcome_emit_batch", async (payload, _ctx) => {
  const input = payload as {
    deploymentId: string;
    key: string;
    value: number;
    unit: string;
    dimensions: Record<string, string>;
    idempotencyKey: string | null;
    emittedAt: string;
  };

  const { createAdminClient } = await import("@/lib/services/supabase");
  const { hasPiiValue } = await import("@/lib/services/outcomes");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // Re-validate PII at worker time (belt-and-suspenders)
  const dims = input.dimensions ?? {};
  for (const v of Object.values(dims)) {
    if (hasPiiValue(String(v))) {
      console.error(JSON.stringify({ event: "outcome_emit_batch.pii_rejected", deploymentId: input.deploymentId }));
      return { status: "rejected", reason: "pii" };
    }
  }

  const { error } = await admin.from("deployment_metrics").insert({
    deployment_id: input.deploymentId,
    metric_key: input.key,
    metric_value: input.value,
    metric_unit: input.unit,
    dimensions: dims,
    idempotency_key: input.idempotencyKey ?? null,
    emitted_at: input.emittedAt,
  });

  if (error) {
    if ((error as { code?: string }).code === "23505") return { status: "deduped" };
    throw new Error(`outcome_emit_batch: ${error.message}`);
  }

  return { status: "inserted" };
});

// ── #51: outcomes rollup partition ──────────────────────────────────────────
// Enqueued by outcomes-rollup-cron every 15 min; calls rollup_outcomes_window(date).
registerHandler("outcomes_rollup_partition", async (payload, _ctx) => {
  const { date } = payload as { date: string };
  if (!date) throw new Error("outcomes_rollup_partition: missing date in payload");

  const { createAdminClient } = await import("@/lib/services/supabase");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  const { data, error } = await admin.rpc("rollup_outcomes_window", { p_date: date });
  if (error) throw new Error(`outcomes_rollup_partition(${date}): ${error.message}`);

  const result = data as { date: string; rows_rolled: number } | null;
  console.log(JSON.stringify({ event: "outcomes_rollup.ok", date, rows_rolled: result?.rows_rolled ?? 0 }));

  // Notify vendors/agencies if cardinality_overflow set for any rollup row today
  const { count } = await admin
    .from("deployment_metrics_rollup")
    .select("id", { count: "exact", head: true })
    .eq("date", date)
    .eq("cardinality_overflow", true);

  if ((count as number | null ?? 0) > 0) {
    console.log(JSON.stringify({
      event: "outcomes_rollup.cardinality_overflow",
      date,
      overflow_count: count,
    }));
    // Full notification fan-out (by deployment → agency/vendor) is a future #52 hook.
    // For now, log the signal so it surfaces in admin observability.
  }

  return { date, rows_rolled: result?.rows_rolled ?? 0 };
});

// ── #50: orphan auto-archive ─────────────────────────────────────────────────
// Enqueued by pg_cron daily; archives orphaned deployments older than 90 days.
// pg_cron handles the SQL directly, so this handler is for service-layer fanout
// (cache invalidation, audit log) after the batch UPDATE.
registerHandler("deployment.orphan_archive", async (payload, _ctx) => {
  const { deploymentIds } = payload as { deploymentIds: string[] };
  if (!Array.isArray(deploymentIds) || deploymentIds.length === 0) return { archived: 0 };

  const { invalidateEffectiveConfig } = await import("@/lib/services/deployments");
  const { createAdminClient } = await import("@/lib/services/supabase");
  const { writeAuditLog } = await import("@/lib/services/admin");
  const admin = createAdminClient();

  const now = new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from("solution_deployments")
    .update({ status: "archived", archived_at: now })
    .in("id", deploymentIds)
    .eq("status", "orphaned");

  await Promise.all(
    deploymentIds.map((id) =>
      Promise.all([
        invalidateEffectiveConfig(id),
        writeAuditLog({
          actorId: null,
          actorRole: "system",
          action: "deployment.orphan_archived",
          entityType: "solution_deployment",
          entityId: id,
          metadata: { reason: "90_day_orphan_auto_archive" },
        }),
      ])
    )
  );

  return { archived: deploymentIds.length };
});

// ── #42: workflow step executor ──────────────────────────────────────────────
// Enqueued by workflow-runner-cron for each claimed run.
// Executes one step slice; the cron tick re-claims for the next step.
// Idempotent: run_steps checkpoint prevents duplicate side effects on retry.
registerHandler("workflow_execute", async (payload, _ctx) => {
  const { runId } = payload as { runId: string };
  if (!runId) throw new Error("workflow_execute: missing runId");

  const { executeRun } = await import("@/lib/services/workflows");
  const result = await executeRun(runId);

  console.log(JSON.stringify({
    event: "workflow_execute.ok",
    run_id: runId,
    status: result.status,
    step_executed: result.stepExecuted,
    next_step_key: result.nextStepKey,
  }));

  return result;
});

// ── #42: workflow schedule trigger ───────────────────────────────────────────
// Enqueued by workflow-runner-cron; calls enqueueScheduledRuns() for schedule-
// triggered workflows whose next_run_iso has passed.
registerHandler("workflow_scheduler", async (_payload, _ctx) => {
  const { enqueueScheduledRuns } = await import("@/lib/services/workflows");
  const result = await enqueueScheduledRuns();
  console.log(JSON.stringify({ event: "workflow_scheduler.ok", enqueued: result.enqueued }));
  return result;
});

// Usage settlement — one job per (vendor_org, batch_window), enqueued by usage-settlement-cron.
// Idempotent: re-runs never double-transfer (Stripe idempotency key per batch).
registerHandler("settlement", async (payload, _ctx) => {
  const { vendorOrgId, vendorStripeAccountId, batchId, batchWindowEnd } = payload as {
    vendorOrgId: string;
    vendorStripeAccountId: string;
    batchId: string;
    batchWindowEnd: string;
  };

  const { settleUsageBatch } = await import("@/lib/services/usage");
  return settleUsageBatch({ vendorOrgId, vendorStripeAccountId, batchId, batchWindowEnd });
});

// ── #52: agency health score refresh ────────────────────────────────────────
// Enqueued on-demand from the agency dashboard; idempotent RPC upsert.
registerHandler("agency_health_refresh", async (payload, _ctx) => {
  const { agencyOrgId } = payload as { agencyOrgId: string };
  const { triggerHealthScoreRefresh } = await import("@/lib/services/agency");
  const updated = await triggerHealthScoreRefresh(agencyOrgId);
  console.log(JSON.stringify({ event: "agency_health_refresh.ok", agencyOrgId, updated }));
  return { agencyOrgId, updated };
});

// ── #55: knowledge parse ─────────────────────────────────────────────────────
// Fetches the source, extracts text, computes content_hash, checks idempotency,
// advances status to chunking, then enqueues knowledge_embed_batch.
registerHandler("knowledge_parse", async (payload, _ctx) => {
  const { docId, orgId } = payload as { docId: string; orgId: string };
  if (!docId) throw new Error("knowledge_parse: missing docId");

  const { createAdminClient } = await import("@/lib/services/supabase");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // Fetch doc row
  const { data: doc, error: docErr } = await admin
    .from("knowledge_documents")
    .select("*")
    .eq("id", docId)
    .single();
  if (docErr) throw new Error(`knowledge_parse: fetch doc: ${docErr.message}`);
  const d = doc as Record<string, unknown>;

  // Already ready or failed — skip
  if (d.status === "ready" || d.status === "failed") return { docId, status: d.status };

  // Mark parsing
  await admin.from("knowledge_documents").update({ status: "parsing" }).eq("id", docId);

  try {
    const { parseDocument } = await import("@/lib/knowledge/ingest/parse");
    const { text, contentHash, title } = await parseDocument({
      sourceType: d.source_type as "upload" | "url" | "connector",
      sourceRef: d.source_ref as string,
      mimeType: d.mime_type as string | null,
    });

    // Idempotency check: same content already indexed in this base?
    const { data: existing } = await admin
      .from("knowledge_documents")
      .select("id, status")
      .eq("knowledge_base_id", d.knowledge_base_id as string)
      .eq("content_hash", contentHash)
      .neq("id", docId)
      .maybeSingle();

    if (existing && (existing as { status: string }).status === "ready") {
      // Duplicate upload — short-circuit, mark this doc ready by reference
      await admin.from("knowledge_documents").update({
        status: "ready",
        content_hash: contentHash,
        title: title ?? d.title ?? null,
        error: null,
      }).eq("id", docId);
      return { docId, status: "ready", reason: "duplicate" };
    }

    // Advance to chunking
    await admin.from("knowledge_documents").update({
      status: "chunking",
      content_hash: contentHash,
      title: title ?? d.title ?? null,
    }).eq("id", docId);

    // Enqueue embed batch with the extracted text
    const { enqueueJob } = await import("@/lib/jobs/queue");
    await enqueueJob("knowledge_embed_batch", {
      docId, orgId, text,
      knowledgeBaseId: d.knowledge_base_id as string,
      tenantShardId: d.tenant_shard_id as number,
    }, {
      idempotencyKey: `knowledge_embed_batch:${docId}:1`,
      orgId,
    });

    console.log(JSON.stringify({ event: "knowledge_parse.ok", docId, contentHash }));
    return { docId, contentHash };
  } catch (err) {
    await admin.from("knowledge_documents").update({
      status: "failed",
      error: String(err),
    }).eq("id", docId);
    throw err;
  }
});

// ── #55: knowledge embed batch ────────────────────────────────────────────────
// Chunks text, embeds via provider, upserts through VectorIndex, meters tokens.
registerHandler("knowledge_embed_batch", async (payload, _ctx) => {
  const { docId, orgId, text, knowledgeBaseId, tenantShardId } = payload as {
    docId: string;
    orgId: string;
    text: string;
    knowledgeBaseId: string;
    tenantShardId: number;
  };

  const { createAdminClient } = await import("@/lib/services/supabase");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // Fetch base for model info
  const { data: base, error: baseErr } = await admin
    .from("knowledge_bases")
    .select("embedding_model, chunker_version")
    .eq("id", knowledgeBaseId)
    .single();
  if (baseErr) throw new Error(`knowledge_embed_batch: fetch base: ${baseErr.message}`);
  const b = base as { embedding_model: string; chunker_version: string };

  await admin.from("knowledge_documents").update({ status: "embedding" }).eq("id", docId);

  try {
    // Resolve embedding key (use platform key fallback)
    const plaintextApiKey = process.env.OPENAI_API_KEY ?? "";
    if (!plaintextApiKey) throw new Error("knowledge_embed_batch: no embedding API key configured");

    const { embedDocument } = await import("@/lib/knowledge/ingest/embed");
    const { chunkCount, tokensUsed } = await embedDocument({
      documentId: docId,
      knowledgeBaseId,
      orgId,
      tenantShardId,
      text,
      embeddingModel: b.embedding_model,
      embeddingVersion: 1,
      chunkerVersion: b.chunker_version,
      plaintextApiKey,
    });

    await admin.from("knowledge_documents").update({
      status: "ready",
      chunk_count: chunkCount,
      error: null,
    }).eq("id", docId);

    console.log(JSON.stringify({ event: "knowledge_embed_batch.ok", docId, chunkCount, tokensUsed }));
    return { docId, chunkCount, tokensUsed };
  } catch (err) {
    await admin.from("knowledge_documents").update({
      status: "failed",
      error: String(err),
    }).eq("id", docId);
    throw err;
  }
});

// ── #55: knowledge reindex (Enrich Engine) ───────────────────────────────────
// Re-embeds docs in a base using a new embedding_version. Writes new version
// rows alongside old; the match_knowledge_chunks RPC picks the max version,
// achieving zero-downtime cutover. This is retrieval improvement, not training.
registerHandler("knowledge_reindex", async (payload, _ctx) => {
  const { knowledgeBaseId, documentId, orgId } = payload as {
    knowledgeBaseId: string;
    documentId?: string;
    orgId: string;
  };

  const { createAdminClient } = await import("@/lib/services/supabase");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // Find the current max embedding_version in this base
  const { data: versionRow } = await admin
    .from("knowledge_chunks")
    .select("embedding_version")
    .eq("knowledge_base_id", knowledgeBaseId)
    .order("embedding_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const currentVersion = (versionRow as { embedding_version: number } | null)?.embedding_version ?? 1;
  const newVersion = currentVersion + 1;

  // Fetch docs to re-embed
  let docsQuery = admin
    .from("knowledge_documents")
    .select("id, source_type, source_ref, mime_type, tenant_shard_id")
    .eq("knowledge_base_id", knowledgeBaseId)
    .eq("org_id", orgId)
    .eq("status", "ready")
    .is("deleted_at", null);

  if (documentId) docsQuery = docsQuery.eq("id", documentId);

  const { data: docs, error } = await docsQuery;
  if (error) throw new Error(`knowledge_reindex: ${error.message}`);

  const { data: base } = await admin
    .from("knowledge_bases")
    .select("embedding_model, chunker_version")
    .eq("id", knowledgeBaseId)
    .single();
  const b = base as { embedding_model: string; chunker_version: string };

  const plaintextApiKey = process.env.OPENAI_API_KEY ?? "";
  const { embedDocument } = await import("@/lib/knowledge/ingest/embed");
  const { parseDocument } = await import("@/lib/knowledge/ingest/parse");

  let reindexed = 0;
  for (const doc of (docs as Record<string, unknown>[]) ?? []) {
    const { text } = await parseDocument({
      sourceType: doc.source_type as "upload" | "url" | "connector",
      sourceRef: doc.source_ref as string,
      mimeType: doc.mime_type as string | null,
    });
    await embedDocument({
      documentId: doc.id as string,
      knowledgeBaseId,
      orgId,
      tenantShardId: doc.tenant_shard_id as number,
      text,
      embeddingModel: b.embedding_model,
      embeddingVersion: newVersion,
      chunkerVersion: b.chunker_version,
      plaintextApiKey,
    });
    reindexed++;
  }

  console.log(JSON.stringify({ event: "knowledge_reindex.ok", knowledgeBaseId, newVersion, reindexed }));
  return { knowledgeBaseId, newVersion, reindexed };
});

// ── #53: client welcome email ────────────────────────────────────────────────
// Enqueued by acceptAgencyInvite when a client relationship becomes active.
// Idempotent: Resend deduplicates on the email side; job idempotency_key = rel_id.
registerHandler("client_welcome_email", async (payload, _ctx) => {
  const { clientEmail, clientName, agencyName, agencyLogoUrl, agencyBrandColor, portalUrl } =
    payload as {
      clientEmail: string;
      clientName: string;
      agencyName: string;
      agencyLogoUrl: string | null;
      agencyBrandColor: string | null;
      portalUrl: string;
    };

  const { sendClientWelcomeEmail } = await import("@/lib/email/resend");

  const wlBranding =
    agencyName
      ? {
          displayName: agencyName,
          logoUrl: agencyLogoUrl ?? "",
          brandColor: agencyBrandColor ?? "#635bff",
        }
      : undefined;

  await sendClientWelcomeEmail({
    clientEmail,
    clientName,
    portalUrl,
    wlBranding,
  });

  console.log(JSON.stringify({ event: "client_welcome_email.sent", clientEmail }));
  return { clientEmail };
});

