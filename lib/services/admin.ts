import { createAdminClient } from "@/lib/services/supabase";
import { formatPrice } from "@/lib/services/apps";
import { sendChurnAlert } from "@/lib/email/resend";
import type { Json } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Audit log helper
// ---------------------------------------------------------------------------

export async function writeAuditLog(args: {
  actorId: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  /** Org that performed the action — stamped on every member-driven mutation. */
  actorOrgId?: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("audit_log").insert({
    actor_id: args.actorId,
    actor_role: args.actorRole,
    action: args.action,
    entity_type: args.entityType,
    entity_id: args.entityId,
    metadata: (args.metadata ?? {}) as unknown as Json,
    actor_org_id: args.actorOrgId ?? null,
  });
  if (error) throw new Error(`writeAuditLog: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Platform stats
// ---------------------------------------------------------------------------

export async function getPlatformStats() {
  const admin = createAdminClient();

  const [{ data: revenueRows }, { data: subRows }, { data: billingRows }] =
    await Promise.all([
      admin
        .from("vendor_revenue_events")
        .select("amount_cents")
        .gt("amount_cents", 0),
      admin
        .from("subscriptions")
        .select("price_cents")
        .in("status", ["active", "trialing"]),
      admin.from("vendor_billing").select("gross_revenue_cents, cut_bps"),
    ]);

  const gmvCents = (revenueRows ?? []).reduce(
    (sum, r) => sum + (r.amount_cents as number),
    0
  );
  const mrrCents = (subRows ?? []).reduce(
    (sum, s) => sum + (s.price_cents as number),
    0
  );
  const cutCents = (billingRows ?? []).reduce(
    (sum, b) =>
      sum +
      Math.floor(
        ((b.gross_revenue_cents as number) * (b.cut_bps as number)) / 10_000
      ),
    0
  );

  return { gmvCents, mrrCents, cutCents };
}

// ---------------------------------------------------------------------------
// Pending apps
// ---------------------------------------------------------------------------

export type PendingApp = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price_cents: number;
  currency: string;
  created_at: string;
  vendor_id: string;
  vendor_name: string | null;
  vendor_charges_enabled: boolean;
  formatted_price: string;
};

export async function getPendingApps(): Promise<PendingApp[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("apps")
    .select(
      "id, name, description, category, price_cents, currency, created_at, vendor_id"
    )
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) throw new Error(`getPendingApps: ${error.message}`);
  if (!data?.length) return [];

  const vendorIds = [...new Set(data.map((a) => a.vendor_id))];
  const { data: vendors } = await admin
    .from("profiles")
    .select("id, display_name, charges_enabled")
    .in("id", vendorIds);

  const vendorMap = new Map(
    (vendors ?? []).map((v) => [
      v.id,
      { name: v.display_name, charges_enabled: v.charges_enabled },
    ])
  );

  return data.map((app) => {
    const vendor = vendorMap.get(app.vendor_id) ?? {
      name: null,
      charges_enabled: false,
    };
    return {
      ...app,
      vendor_id: app.vendor_id,
      vendor_name: vendor.name,
      vendor_charges_enabled: vendor.charges_enabled,
      formatted_price: formatPrice(app.price_cents, app.currency),
    };
  });
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

export type VendorRow = {
  id: string;
  display_name: string | null;
  stripe_account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  created_at: string;
};

export async function getVendors(): Promise<VendorRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select(
      "id, display_name, stripe_account_id, charges_enabled, payouts_enabled, created_at"
    )
    .eq("role", "vendor")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`getVendors: ${error.message}`);
  return (data ?? []) as VendorRow[];
}

// ---------------------------------------------------------------------------
// Subscriptions (all — admin view; buyer_id is uuid only, no PII)
// ---------------------------------------------------------------------------

export type AdminSubscription = {
  id: string;
  app_name: string;
  buyer_id: string;
  status: string;
  price_cents: number;
  currency: string;
  cancel_at_period_end: boolean;
  current_period_end: string;
  created_at: string;
  formatted_price: string;
};

export async function getAllSubscriptions({
  page = 1,
  pageSize = 25,
}: { page?: number; pageSize?: number } = {}): Promise<{
  subscriptions: AdminSubscription[];
  total: number;
  totalPages: number;
}> {
  const admin = createAdminClient();
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await admin
    .from("subscriptions")
    .select(
      "id, buyer_id, status, price_cents, currency, cancel_at_period_end, current_period_end, created_at, app_id",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) throw new Error(`getAllSubscriptions: ${error.message}`);

  const appIds = [...new Set((data ?? []).map((s) => s.app_id))];
  const { data: apps } =
    appIds.length > 0
      ? await admin.from("apps").select("id, name").in("id", appIds)
      : { data: [] };
  const appMap = new Map((apps ?? []).map((a) => [a.id, a.name]));

  return {
    subscriptions: (data ?? []).map((s) => ({
      id: s.id,
      app_name: appMap.get(s.app_id) ?? s.app_id,
      buyer_id: s.buyer_id,
      status: s.status,
      price_cents: s.price_cents,
      currency: s.currency,
      cancel_at_period_end: s.cancel_at_period_end,
      current_period_end: s.current_period_end,
      created_at: s.created_at,
      formatted_price: formatPrice(s.price_cents, s.currency),
    })),
    total: count ?? 0,
    totalPages: Math.ceil((count ?? 0) / pageSize),
  };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditEntry = {
  id: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Json;
  created_at: string;
};

export async function getAuditLog({
  actorId,
  entityType,
  since,
  until,
  page = 1,
  pageSize = 50,
}: {
  actorId?: string;
  entityType?: string;
  since?: string;
  until?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<{
  entries: AuditEntry[];
  total: number;
  totalPages: number;
}> {
  const admin = createAdminClient();
  let query = admin
    .from("audit_log")
    .select(
      "id, actor_id, actor_role, action, entity_type, entity_id, metadata, created_at",
      { count: "exact" }
    )
    .order("created_at", { ascending: false });

  if (actorId) query = query.eq("actor_id", actorId);
  if (entityType) query = query.eq("entity_type", entityType);
  if (since) query = query.gte("created_at", since);
  if (until) query = query.lte("created_at", until);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw new Error(`getAuditLog: ${error.message}`);

  return {
    entries: (data ?? []) as AuditEntry[],
    total: count ?? 0,
    totalPages: Math.ceil((count ?? 0) / pageSize),
  };
}

// ---------------------------------------------------------------------------
// Churn detection
// ---------------------------------------------------------------------------

export type ChurnAlert = {
  vendor_id: string;
  vendor_name: string | null;
  rate_bps: number;
  canceled: number;
  active_at_start: number;
  already_alerted: boolean;
};

export async function getChurnAlerts(
  thresholdBps: number
): Promise<ChurnAlert[]> {
  const admin = createAdminClient();

  const now = new Date();
  // Last calendar month
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const periodStart = new Date(
    Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() - 1, 1)
  );
  const monthKey = periodStart.toISOString().slice(0, 7); // "YYYY-MM"

  const [{ data: vendors }, { data: apps }] = await Promise.all([
    admin
      .from("profiles")
      .select("id, display_name")
      .eq("role", "vendor"),
    admin.from("apps").select("id, vendor_id"),
  ]);

  if (!vendors?.length) return [];

  // Check which vendor+month combos already have an alert sent
  const { data: sentAlerts } = await admin
    .from("audit_log")
    .select("entity_id, metadata")
    .eq("action", "churn.alert_sent")
    .gte("created_at", periodStart.toISOString());

  const alertedVendors = new Set(
    (sentAlerts ?? [])
      .filter((e) => {
        const meta = e.metadata as Record<string, unknown> | null;
        return meta?.month === monthKey;
      })
      .map((e) => e.entity_id)
  );

  const vendorApps = new Map<string, string[]>();
  for (const app of apps ?? []) {
    const list = vendorApps.get(app.vendor_id) ?? [];
    list.push(app.id);
    vendorApps.set(app.vendor_id, list);
  }

  const alerts: ChurnAlert[] = [];

  for (const vendor of vendors) {
    const appIds = vendorApps.get(vendor.id);
    if (!appIds?.length) continue;

    const [{ count: activeAtStart }, { count: canceledInPeriod }] =
      await Promise.all([
        admin
          .from("subscriptions")
          .select("id", { count: "exact", head: true })
          .in("app_id", appIds)
          .lt("created_at", periodEnd.toISOString())
          .or(
            `canceled_at.is.null,canceled_at.gt.${periodStart.toISOString()}`
          ),
        admin
          .from("subscriptions")
          .select("id", { count: "exact", head: true })
          .in("app_id", appIds)
          .gte("canceled_at", periodStart.toISOString())
          .lt("canceled_at", periodEnd.toISOString()),
      ]);

    const start = activeAtStart ?? 0;
    const canceled = canceledInPeriod ?? 0;
    if (start === 0) continue;

    const rateBps = Math.floor((canceled * 10_000) / start);
    if (rateBps > thresholdBps) {
      alerts.push({
        vendor_id: vendor.id,
        vendor_name: vendor.display_name,
        rate_bps: rateBps,
        canceled,
        active_at_start: start,
        already_alerted: alertedVendors.has(vendor.id),
      });
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Vendor cut override (admin-only)
// ---------------------------------------------------------------------------

export type VendorCutInfo = {
  vendor_id: string;
  display_name: string | null;
  cut_bps_override: number | null;
  auto_tier_cut_bps: number;
  effective_cut_bps: number;
};

export async function getVendorsWithCutInfo(): Promise<VendorCutInfo[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_get_vendors_cut_info");
  if (error) throw new Error(`getVendorsWithCutInfo: ${error.message}`);
  return (data ?? []) as VendorCutInfo[];
}

export async function setVendorCutOverride({
  adminId,
  vendorId,
  newBps,
  reason,
}: {
  adminId: string;
  vendorId: string;
  newBps: number | null;
  reason: string;
}): Promise<void> {
  if (reason.trim().length < 10) {
    throw new Error("reason is required and must be ≥10 characters");
  }
  if (newBps !== null && (newBps < 0 || newBps > 5000)) {
    throw new Error("newBps must be 0..5000 or null");
  }

  const admin = createAdminClient();

  const { data: before } = await admin
    .from("profiles")
    .select("vendor_cut_bps_override, role")
    .eq("id", vendorId)
    .maybeSingle();

  if (!before) throw new Error("vendor not found");
  if (before.role !== "vendor") throw new Error("target user is not a vendor");

  // Supabase type-gen doesn't emit nullable for RPC args — cast needed for null-able bps params.
  const { error } = await (admin.rpc as Function)("admin_set_vendor_cut_override", {
    p_admin_id: adminId,
    p_vendor_id: vendorId,
    p_new_bps: newBps,
    p_reason: reason,
    p_old_bps: before.vendor_cut_bps_override ?? null,
  });
  if (error) throw new Error(`setVendorCutOverride: ${error.message}`);
}

// Send churn alert emails for newly-flagged vendors and record in audit_log
export async function dispatchChurnAlerts(alerts: ChurnAlert[]): Promise<void> {
  const admin = createAdminClient();

  const now = new Date();
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  const monthKey = periodStart.toISOString().slice(0, 7);

  const newAlerts = alerts.filter((a) => !a.already_alerted);

  for (const alert of newAlerts) {
    await sendChurnAlert({
      vendorName: alert.vendor_name,
      vendorId: alert.vendor_id,
      rateBps: alert.rate_bps,
      canceled: alert.canceled,
      activeAtStart: alert.active_at_start,
      month: monthKey,
    });

    await admin.from("audit_log").insert({
      actor_id: null,
      actor_role: "system",
      action: "churn.alert_sent",
      entity_type: "profiles",
      entity_id: alert.vendor_id,
      metadata: { month: monthKey, rate_bps: alert.rate_bps } as unknown as Json,
    });
  }
}
