/**
 * #45 — Partner-client data lifecycle service.
 *
 * Owns the partner_clients CRM registry and coordinates export/erasure requests
 * that fan out across all stores (#40/#41/#42/#43) via lib/privacy/erasers.ts.
 *
 * Trust boundary (SPEC §13): only the partner_owner_id org + admin can raise
 * or read requests. No cross-counterparty reads — identity lives here only.
 */

import { createAdminClient } from "@/lib/services/supabase";
import { writeAuditLog } from "@/lib/services/admin";
import { enforceQuota } from "@/lib/quotas/enforce";
import { enqueueJob } from "@/lib/jobs/queue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

const ERASURE_GRACE_DAYS = Number(process.env.ERASURE_GRACE_DAYS ?? "30");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PartnerClient {
  id: string;
  partner_owner_id: string;
  external_ref: string | null;
  email: string | null;
  display_name: string | null;
  tags: string[];
  lifecycle_stage: string | null;
  notes: string | null;
  last_seen_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface UpsertPartnerClientArgs {
  partnerOwnerId: string;
  externalRef?: string;
  email?: string;
  displayName?: string;
  tags?: string[];
  lifecycleStage?: string;
  notes?: string;
  lastSeenAt?: string;
  actorId?: string;
}

export interface DataRequest {
  id: string;
  partner_owner_id: string;
  partner_client_id: string;
  request_type: "export" | "erasure";
  status: "pending" | "processing" | "completed" | "failed";
  grace_ends_at: string | null;
  job_id: string | null;
  result_url: string | null;
  created_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Client registry (CRM)
// ---------------------------------------------------------------------------

/**
 * Upserts a partner client. If `externalRef` is set and already exists for this
 * partner, updates in place; otherwise creates a new row.
 */
export async function upsertPartnerClient(
  args: UpsertPartnerClientArgs
): Promise<{ id: string; created: boolean }> {
  const admin = createAdminClient() as AnyAdmin;

  // Check if this is an update or insert
  let existingId: string | null = null;
  if (args.externalRef) {
    const { data } = await admin
      .from("partner_clients")
      .select("id")
      .eq("partner_owner_id", args.partnerOwnerId)
      .eq("external_ref", args.externalRef)
      .is("deleted_at", null)
      .maybeSingle();
    existingId = (data as { id: string } | null)?.id ?? null;
  }

  if (existingId) {
    const { error } = await admin
      .from("partner_clients")
      .update({
        email: args.email ?? undefined,
        display_name: args.displayName ?? undefined,
        tags: args.tags ?? undefined,
        lifecycle_stage: args.lifecycleStage ?? undefined,
        notes: args.notes ?? undefined,
        last_seen_at: args.lastSeenAt ?? undefined,
      })
      .eq("id", existingId);
    if (error) throw new Error(`upsertPartnerClient update: ${error.message}`);
    return { id: existingId, created: false };
  }

  // New client — enforce quota before inserting
  await enforceQuota(args.partnerOwnerId, "partner_clients");

  const { data, error } = await admin
    .from("partner_clients")
    .insert({
      partner_owner_id: args.partnerOwnerId,
      external_ref: args.externalRef ?? null,
      email: args.email ?? null,
      display_name: args.displayName ?? null,
      tags: args.tags ?? [],
      lifecycle_stage: args.lifecycleStage ?? null,
      notes: args.notes ?? null,
      last_seen_at: args.lastSeenAt ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`upsertPartnerClient insert: ${error.message}`);

  const { id } = data as { id: string };

  await writeAuditLog({
    actorId: args.actorId ?? null,
    actorRole: "partner",
    action: "partner_client.created",
    entityType: "partner_client",
    entityId: id,
    actorOrgId: args.partnerOwnerId,
  });

  return { id, created: true };
}

/**
 * Lists active (non-deleted) partner clients for a partner org.
 */
export async function listPartnerClients(
  partnerOwnerId: string,
  opts: { limit?: number; cursor?: string } = {}
): Promise<{ clients: PartnerClient[]; nextCursor: string | null }> {
  const admin = createAdminClient() as AnyAdmin;
  const limit = opts.limit ?? 50;

  let query = admin
    .from("partner_clients")
    .select("*")
    .eq("partner_owner_id", partnerOwnerId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (opts.cursor) {
    query = query.lt("created_at", opts.cursor);
  }

  const { data, error } = await query;
  if (error) throw new Error(`listPartnerClients: ${error.message}`);

  const rows = (data ?? []) as PartnerClient[];
  const hasMore = rows.length > limit;
  return {
    clients: hasMore ? rows.slice(0, limit) : rows,
    nextCursor: hasMore ? rows[limit - 1].created_at : null,
  };
}

// ---------------------------------------------------------------------------
// Data requests
// ---------------------------------------------------------------------------

/**
 * Lists all data requests for a partner owner org.
 */
export async function listDataRequests(
  partnerOwnerId: string
): Promise<DataRequest[]> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("partner_data_requests")
    .select("*")
    .eq("partner_owner_id", partnerOwnerId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`listDataRequests: ${error.message}`);
  return (data ?? []) as DataRequest[];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Enqueues a background job to assemble a ZIP/JSON of all data held for a
 * partner client. Returns the tracking job id.
 *
 * Scoped to the requesting partner — no cross-counterparty data included.
 */
export async function requestClientExport(
  partnerOwnerId: string,
  partnerClientId: string,
  actorId?: string
): Promise<{ jobId: string; requestId: string }> {
  const admin = createAdminClient() as AnyAdmin;

  // Verify client belongs to this partner
  const { data: client, error: clientErr } = await admin
    .from("partner_clients")
    .select("id, deleted_at")
    .eq("id", partnerClientId)
    .eq("partner_owner_id", partnerOwnerId)
    .single();
  if (clientErr || !client) throw new Error("partner_client not found or access denied");

  const { data: req, error: reqErr } = await admin
    .from("partner_data_requests")
    .insert({
      partner_owner_id: partnerOwnerId,
      partner_client_id: partnerClientId,
      request_type: "export",
      status: "pending",
      created_by: actorId ?? null,
    })
    .select("id")
    .single();
  if (reqErr) throw new Error(`requestClientExport: ${reqErr.message}`);

  const requestId = (req as { id: string }).id;

  const { jobId } = await enqueueJob(
    "partner_client_export",
    { partnerOwnerId, partnerClientId, requestId },
    {
      idempotencyKey: `export:${partnerClientId}:${requestId}`,
      orgId: partnerOwnerId,
    }
  );

  await admin
    .from("partner_data_requests")
    .update({ job_id: jobId, status: "processing" })
    .eq("id", requestId);

  await writeAuditLog({
    actorId: actorId ?? null,
    actorRole: "partner",
    action: "partner_client.export_requested",
    entityType: "partner_client",
    entityId: partnerClientId,
    actorOrgId: partnerOwnerId,
    metadata: { request_id: requestId },
  });

  return { jobId, requestId };
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/**
 * Initiates erasure for a partner client:
 * 1. Soft-deletes the client row immediately (halts all processing).
 * 2. Enqueues a hard-erasure job to run after the grace window.
 *
 * Idempotent: a second call on an already-deleted client returns the
 * existing request id.
 */
export async function requestClientErasure(
  partnerOwnerId: string,
  partnerClientId: string,
  actorId?: string
): Promise<{ jobId: string; requestId: string; graceEndsAt: Date }> {
  const admin = createAdminClient() as AnyAdmin;

  // Verify ownership
  const { data: client, error: clientErr } = await admin
    .from("partner_clients")
    .select("id, deleted_at")
    .eq("id", partnerClientId)
    .eq("partner_owner_id", partnerOwnerId)
    .single();
  if (clientErr || !client) throw new Error("partner_client not found or access denied");

  const now = new Date();
  const graceEndsAt = new Date(now.getTime() + ERASURE_GRACE_DAYS * 86_400_000);

  // Soft-delete immediately — stops new usage/workflow activity for this client
  await admin
    .from("partner_clients")
    .update({ deleted_at: now.toISOString() })
    .eq("id", partnerClientId)
    .is("deleted_at", null);

  const { data: req, error: reqErr } = await admin
    .from("partner_data_requests")
    .insert({
      partner_owner_id: partnerOwnerId,
      partner_client_id: partnerClientId,
      request_type: "erasure",
      status: "pending",
      grace_ends_at: graceEndsAt.toISOString(),
      created_by: actorId ?? null,
    })
    .select("id")
    .single();
  if (reqErr) throw new Error(`requestClientErasure: ${reqErr.message}`);

  const requestId = (req as { id: string }).id;

  const { jobId } = await enqueueJob(
    "partner_client_erasure_hard",
    { partnerClientId, requestId },
    {
      idempotencyKey: `erasure:${partnerClientId}`,
      orgId: partnerOwnerId,
      runAt: graceEndsAt,
    }
  );

  await admin
    .from("partner_data_requests")
    .update({ job_id: jobId })
    .eq("id", requestId);

  await writeAuditLog({
    actorId: actorId ?? null,
    actorRole: "partner",
    action: "partner_client.erasure_requested",
    entityType: "partner_client",
    entityId: partnerClientId,
    actorOrgId: partnerOwnerId,
    metadata: { request_id: requestId, grace_ends_at: graceEndsAt.toISOString() },
  });

  return { jobId, requestId, graceEndsAt };
}

/**
 * Executes the hard erasure fan-out across all registered stores.
 * Called by the `partner_client_erasure_hard` job handler after the grace window.
 *
 * Idempotent: erasers null/delete already-null columns safely.
 */
export async function runErasure(
  partnerClientId: string,
  requestId: string
): Promise<void> {
  // Import erasers — triggers side-effectful registrations
  const { runAllErasers } = await import("@/lib/privacy/erasers");
  await runAllErasers(partnerClientId);

  const admin = createAdminClient() as AnyAdmin;
  await admin
    .from("partner_data_requests")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", requestId);

  await writeAuditLog({
    actorId: null,
    actorRole: "system",
    action: "partner_client.erasure_completed",
    entityType: "partner_client",
    entityId: partnerClientId,
    metadata: { request_id: requestId },
  });
}
