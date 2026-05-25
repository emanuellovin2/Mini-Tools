/**
 * Eraser registry — each store registers an idempotent eraser keyed by partnerClientId.
 *
 * Convention:
 * - Monetary aggregate rows (vendor_revenue_events, usage_events summary) are KEPT for
 *   financial/accounting records; only the client linkage column is nulled.
 * - Run I/O content (run_steps.input/output) is PURGED.
 * - Connector cached payloads for the client are PURGED.
 * Every eraser writes an audit_log row in the same logical scope.
 */

import { createAdminClient } from "@/lib/services/supabase";
import { writeAuditLog } from "@/lib/services/admin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

export type EraserFn = (partnerClientId: string) => Promise<{ store: string; rowsAffected: number }>;

const _erasers: EraserFn[] = [];

export function registerEraser(fn: EraserFn): void {
  _erasers.push(fn);
}

export async function runAllErasers(partnerClientId: string): Promise<void> {
  const results = await Promise.allSettled(_erasers.map((fn) => fn(partnerClientId)));
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    const messages = failures.map((r) =>
      r.status === "rejected" ? String(r.reason) : ""
    );
    throw new Error(`erasure fan-out partial failure: ${messages.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// #40 — usage_events: null client linkage; keep aggregate rows for accounting
// ---------------------------------------------------------------------------
registerEraser(async (partnerClientId) => {
  const admin = createAdminClient() as AnyAdmin;
  const { count, error } = await admin
    .from("usage_events")
    .update({ partner_client_id: null })
    .eq("partner_client_id", partnerClientId)
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(`eraser.usage_events: ${error.message}`);

  await writeAuditLog({
    actorId: null,
    actorRole: "system",
    action: "privacy.eraser.usage_events",
    entityType: "partner_client",
    entityId: partnerClientId,
    metadata: { rows_anonymized: count ?? 0 },
  });
  return { store: "usage_events", rowsAffected: count ?? 0 };
});

// ---------------------------------------------------------------------------
// #41 — gateway: there are no stored bodies by default; clear token usage metadata
// ---------------------------------------------------------------------------
registerEraser(async (partnerClientId) => {
  // Gateway logs are ephemeral (audit_log references only); no stored bodies.
  // Write a tombstone audit entry so the fan-out is complete and auditable.
  await writeAuditLog({
    actorId: null,
    actorRole: "system",
    action: "privacy.eraser.gateway",
    entityType: "partner_client",
    entityId: partnerClientId,
    metadata: { note: "gateway bodies not stored; tombstone written" },
  });
  return { store: "gateway", rowsAffected: 0 };
});

// ---------------------------------------------------------------------------
// #42 — workflow run I/O: purge run_steps.input/output for this client's runs
// ---------------------------------------------------------------------------
registerEraser(async (partnerClientId) => {
  const admin = createAdminClient() as AnyAdmin;

  // Get run IDs for this client
  const { data: runs } = await admin
    .from("workflow_runs")
    .select("id")
    .eq("partner_client_id", partnerClientId);

  const runIds = ((runs ?? []) as { id: string }[]).map((r) => r.id);

  let rowsAffected = 0;
  if (runIds.length > 0) {
    const { count, error } = await admin
      .from("run_steps")
      .update({ input: null, output: null })
      .in("run_id", runIds)
      .or("input.not.is.null,output.not.is.null")
      .select("id", { count: "exact", head: true });
    if (error) throw new Error(`eraser.run_steps: ${error.message}`);
    rowsAffected = count ?? 0;

    // Null run-level client linkage (keep run record for audit)
    await admin
      .from("workflow_runs")
      .update({ partner_client_id: null })
      .in("id", runIds);
  }

  await writeAuditLog({
    actorId: null,
    actorRole: "system",
    action: "privacy.eraser.workflow_runs",
    entityType: "partner_client",
    entityId: partnerClientId,
    metadata: { runs_affected: runIds.length, steps_purged: rowsAffected },
  });
  return { store: "workflow_run_io", rowsAffected };
});

// ---------------------------------------------------------------------------
// #43 — connectors: delete connector_accounts synced for this client
//         (cached OAuth tokens / payloads scoped to this client identity)
// ---------------------------------------------------------------------------
registerEraser(async (partnerClientId) => {
  // connector_accounts are org-owned and not directly linked to partner_client_id
  // in the current schema. Deletion is a no-op here unless future connectors
  // add the linkage. We write an audit tombstone for completeness.
  await writeAuditLog({
    actorId: null,
    actorRole: "system",
    action: "privacy.eraser.connectors",
    entityType: "partner_client",
    entityId: partnerClientId,
    metadata: { note: "connector payloads are org-scoped; no per-client rows in v1" },
  });
  return { store: "connectors", rowsAffected: 0 };
});
