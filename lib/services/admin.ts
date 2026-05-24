import { createAdminClient } from "@/lib/services/supabase";
import { formatPrice } from "@/lib/services/apps";
import type { Json } from "@/types/supabase";

// feature_flags rows come back as plain objects; the table is new and not yet
// in the auto-generated types, so we keep a local type instead.
export type FeatureFlag = {
  name: string;
  enabled: boolean;
  description: string | null;
  updated_by: string | null;
  updated_at: string;
};

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

// Dispatch churn alerts. Each alert is enqueued as a durable `churn_alert_email`
// job (handler in lib/jobs/handlers.ts) — Resend outages or transient email
// failures retry with exponential backoff rather than dropping the alert on
// the floor or blocking the calling cron. Idempotent via job idempotency_key.
export async function dispatchChurnAlerts(alerts: ChurnAlert[]): Promise<void> {
  const { enqueueJob } = await import("@/lib/jobs/queue");

  const now = new Date();
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  const monthKey = periodStart.toISOString().slice(0, 7);

  const newAlerts = alerts.filter((a) => !a.already_alerted);

  for (const alert of newAlerts) {
    await enqueueJob(
      "churn_alert_email",
      {
        vendorId: alert.vendor_id,
        vendorName: alert.vendor_name,
        rateBps: alert.rate_bps,
        canceled: alert.canceled,
        activeAtStart: alert.active_at_start,
        month: monthKey,
      },
      {
        // One alert per (vendor, month) — duplicate enqueues return the existing job.
        idempotencyKey: `churn_alert:${alert.vendor_id}:${monthKey}`,
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Take-rate trend (last N months from vendor_billing)
// ---------------------------------------------------------------------------

export type TakeRateMonth = {
  month: string; // "YYYY-MM"
  gmv_cents: number;
  cut_cents: number;
  rate_bps: number;
};

export async function getTakeRateTrend(months = 12): Promise<TakeRateMonth[]> {
  const admin = createAdminClient();
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months);
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

  const { data, error } = await admin
    .from("vendor_billing")
    .select("period_start, gross_revenue_cents, cut_bps")
    .gte("period_start", since.toISOString())
    .order("period_start", { ascending: true });
  if (error) throw new Error(`getTakeRateTrend: ${error.message}`);

  // Group by YYYY-MM
  const byMonth = new Map<string, { gmv: number; cut: number }>();
  for (const row of data ?? []) {
    const key = row.period_start.slice(0, 7);
    const existing = byMonth.get(key) ?? { gmv: 0, cut: 0 };
    const cut = Math.floor((row.gross_revenue_cents * row.cut_bps) / 10_000);
    byMonth.set(key, { gmv: existing.gmv + row.gross_revenue_cents, cut: existing.cut + cut });
  }

  return Array.from(byMonth.entries()).map(([month, { gmv, cut }]) => ({
    month,
    gmv_cents: gmv,
    cut_cents: cut,
    rate_bps: gmv > 0 ? Math.floor((cut * 10_000) / gmv) : 0,
  }));
}

// ---------------------------------------------------------------------------
// Channel mix (last N months from subscriptions)
// ---------------------------------------------------------------------------

export type ChannelMixMonth = {
  month: string;
  direct: number;
  affiliate: number;
  reseller: number;
};

export async function getChannelMix(months = 12): Promise<ChannelMixMonth[]> {
  const admin = createAdminClient();
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months);
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

  const { data, error } = await admin
    .from("subscriptions")
    .select("created_at, affiliate_id, reseller_id")
    .gte("created_at", since.toISOString());
  if (error) throw new Error(`getChannelMix: ${error.message}`);

  const byMonth = new Map<string, ChannelMixMonth>();
  for (const row of data ?? []) {
    const key = row.created_at.slice(0, 7);
    const existing = byMonth.get(key) ?? { month: key, direct: 0, affiliate: 0, reseller: 0 };
    if (row.reseller_id) {
      existing.reseller++;
    } else if (row.affiliate_id) {
      existing.affiliate++;
    } else {
      existing.direct++;
    }
    byMonth.set(key, existing);
  }

  return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
}

// ---------------------------------------------------------------------------
// Concentration risk (top 5 vendors by GMV)
// ---------------------------------------------------------------------------

export type VendorConcentration = {
  vendor_id: string;
  vendor_name: string | null;
  gmv_cents: number;
  share_bps: number; // share of total GMV in basis points
};

export type ConcentrationRisk = {
  top5: VendorConcentration[];
  total_gmv_cents: number;
  alarm: boolean; // true if any vendor > 20% of GMV
};

export async function getConcentrationRisk(): Promise<ConcentrationRisk> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("vendor_revenue_events")
    .select("vendor_id, amount_cents")
    .gt("amount_cents", 0);
  if (error) throw new Error(`getConcentrationRisk: ${error.message}`);

  const byVendor = new Map<string, number>();
  let total = 0;
  for (const row of data ?? []) {
    byVendor.set(row.vendor_id, (byVendor.get(row.vendor_id) ?? 0) + row.amount_cents);
    total += row.amount_cents;
  }

  if (total === 0) return { top5: [], total_gmv_cents: 0, alarm: false };

  const vendorIds = [...byVendor.keys()];
  const { data: profiles } = vendorIds.length > 0
    ? await admin.from("profiles").select("id, display_name").in("id", vendorIds)
    : { data: [] };
  const nameMap = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

  const sorted = Array.from(byVendor.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([vendor_id, gmv_cents]) => ({
      vendor_id,
      vendor_name: nameMap.get(vendor_id) ?? null,
      gmv_cents,
      share_bps: Math.floor((gmv_cents * 10_000) / total),
    }));

  return {
    top5: sorted,
    total_gmv_cents: total,
    alarm: sorted.some((v) => v.share_bps > 2000), // >20%
  };
}

// ---------------------------------------------------------------------------
// Payout obligation (active MRR distributed by channel)
// ---------------------------------------------------------------------------

export type PayoutObligation = {
  vendor_mrr_cents: number;   // direct vendor share (after platform cut)
  affiliate_mrr_cents: number; // affiliate share
  reseller_mrr_cents: number;  // reseller share
  total_mrr_cents: number;
  vendor_count: number;
  affiliate_count: number;
  reseller_count: number;
};

export async function getPayoutObligation(): Promise<PayoutObligation> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("subscriptions")
    .select("price_cents, affiliate_id, reseller_id, affiliate_commission_snapshot_bps, vendor_floor_snapshot_cents")
    .in("status", ["active", "trialing"]);
  if (error) throw new Error(`getPayoutObligation: ${error.message}`);

  let vendorMrr = 0, affiliateMrr = 0, resellerMrr = 0;
  const vendorIds = new Set<string>(), affiliateIds = new Set<string>(), resellerIds = new Set<string>();

  for (const sub of data ?? []) {
    if (sub.reseller_id) {
      resellerIds.add(sub.reseller_id);
      resellerMrr += sub.vendor_floor_snapshot_cents ?? Math.floor(sub.price_cents * 0.5);
    } else if (sub.affiliate_id) {
      affiliateIds.add(sub.affiliate_id);
      const commBps = sub.affiliate_commission_snapshot_bps ?? 2000;
      const platformCut = Math.floor(sub.price_cents * 0.05);
      affiliateMrr += Math.floor((sub.price_cents - platformCut) * commBps / 10_000);
      vendorMrr += sub.price_cents - platformCut - Math.floor((sub.price_cents - platformCut) * commBps / 10_000);
    } else {
      // direct: vendor gets (price - platform cut)
      vendorMrr += Math.floor(sub.price_cents * 0.88); // ~88% (Tier 1 cut 12%)
    }
  }

  return {
    vendor_mrr_cents: vendorMrr,
    affiliate_mrr_cents: affiliateMrr,
    reseller_mrr_cents: resellerMrr,
    total_mrr_cents: vendorMrr + affiliateMrr + resellerMrr,
    vendor_count: vendorIds.size || (data ?? []).filter((s) => !s.affiliate_id && !s.reseller_id).length,
    affiliate_count: affiliateIds.size,
    reseller_count: resellerIds.size,
  };
}

// ---------------------------------------------------------------------------
// Webhook events health
// ---------------------------------------------------------------------------

export type WebhookEventRow = {
  id: string;
  type: string;
  status: string;
  received_at: string;
  processed_at: string | null;
  error: string | null;
};

export type WebhookStats = {
  received_1h: number;
  processed_1h: number;
  failed_1h: number;
  received_24h: number;
  failed_24h: number;
  dlq: WebhookEventRow[]; // failed/retrying — last 20
  last_received_at: string | null;
  lag_seconds: number | null; // seconds since last received event
};

export async function getWebhookStats(): Promise<WebhookStats> {
  const admin = createAdminClient();
  const now = new Date();
  const ago1h = new Date(now.getTime() - 3600_000).toISOString();
  const ago24h = new Date(now.getTime() - 86400_000).toISOString();

  const [{ data: recent24h }, { data: dlqRows }, { data: lastRow }] = await Promise.all([
    admin
      .from("webhook_events")
      .select("status, received_at")
      .gte("received_at", ago24h),
    admin
      .from("webhook_events")
      .select("id, type, status, received_at, processed_at, error")
      .eq("status", "failed")
      .order("received_at", { ascending: false })
      .limit(20),
    admin
      .from("webhook_events")
      .select("received_at")
      .order("received_at", { ascending: false })
      .limit(1),
  ]);

  const rows24 = recent24h ?? [];
  const received_24h = rows24.length;
  const failed_24h = rows24.filter((r) => r.status === "failed").length;

  const rows1h = rows24.filter((r) => r.received_at >= ago1h);
  const received_1h = rows1h.length;
  const processed_1h = rows1h.filter((r) => r.status === "processed").length;
  const failed_1h = rows1h.filter((r) => r.status === "failed").length;

  const last_received_at = lastRow?.[0]?.received_at ?? null;
  const lag_seconds = last_received_at
    ? Math.floor((now.getTime() - new Date(last_received_at).getTime()) / 1000)
    : null;

  return {
    received_1h,
    processed_1h,
    failed_1h,
    received_24h,
    failed_24h,
    dlq: (dlqRows ?? []) as WebhookEventRow[],
    last_received_at,
    lag_seconds,
  };
}

// ---------------------------------------------------------------------------
// System health composite
// ---------------------------------------------------------------------------

export type HealthStatus = "ok" | "warn" | "error";
export type SystemHealthCheck = {
  label: string;
  status: HealthStatus;
  detail: string;
};

export type SystemHealth = {
  overall: HealthStatus;
  checks: SystemHealthCheck[];
};

export async function getSystemHealth(): Promise<SystemHealth> {
  const admin = createAdminClient();
  const checks: SystemHealthCheck[] = [];

  // DB connectivity — if we got here the admin client works
  checks.push({ label: "Database", status: "ok", detail: "Connected" });

  // Webhook lag
  const { data: lastWebhook } = await admin
    .from("webhook_events")
    .select("received_at")
    .order("received_at", { ascending: false })
    .limit(1);
  const lastWh = lastWebhook?.[0]?.received_at;
  if (!lastWh) {
    checks.push({ label: "Webhook lag", status: "warn", detail: "No events recorded yet" });
  } else {
    const lag = Math.floor((Date.now() - new Date(lastWh).getTime()) / 1000);
    checks.push({
      label: "Webhook lag",
      status: lag > 300 ? "error" : lag > 60 ? "warn" : "ok",
      detail: lag < 60 ? `${lag}s ago` : lag < 3600 ? `${Math.floor(lag / 60)}m ago` : `${Math.floor(lag / 3600)}h ago`,
    });
  }

  // Reconciliation drift
  const { data: reconRuns } = await admin
    .from("reconciliation_runs")
    .select("drift_count, run_at")
    .order("run_at", { ascending: false })
    .limit(1);
  const lastRun = reconRuns?.[0];
  if (!lastRun) {
    checks.push({ label: "Reconciliation", status: "warn", detail: "No runs yet" });
  } else {
    const drift = lastRun.drift_count ?? 0;
    const hoursAgo = Math.floor((Date.now() - new Date(lastRun.run_at).getTime()) / 3600_000);
    checks.push({
      label: "Reconciliation",
      status: drift > 0 ? "warn" : "ok",
      detail: drift > 0 ? `${drift} drift item${drift !== 1 ? "s" : ""} · ${hoursAgo}h ago` : `Clean · ${hoursAgo}h ago`,
    });
  }

  // Failed webhooks in last hour
  const ago1h = new Date(Date.now() - 3600_000).toISOString();
  const { count: failedCount } = await admin
    .from("webhook_events")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed")
    .gte("received_at", ago1h);
  if ((failedCount ?? 0) > 0) {
    checks.push({ label: "Webhook errors", status: "error", detail: `${failedCount} failed in last hour` });
  }

  const overall: HealthStatus = checks.some((c) => c.status === "error")
    ? "error"
    : checks.some((c) => c.status === "warn")
    ? "warn"
    : "ok";

  return { overall, checks };
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export async function getFeatureFlags(): Promise<FeatureFlag[]> {
  const admin = createAdminClient();
  // feature_flags is a new table; cast via unknown until types are regenerated
  const { data, error } = await (admin as unknown as { from: (t: string) => any })
    .from("feature_flags")
    .select("name, enabled, description, updated_by, updated_at")
    .order("name");
  if (error) throw new Error(`getFeatureFlags: ${error.message}`);
  return (data ?? []) as FeatureFlag[];
}

export async function setFeatureFlag(
  name: string,
  enabled: boolean,
  adminId: string
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await (admin as unknown as { from: (t: string) => any })
    .from("feature_flags")
    .update({ enabled, updated_by: adminId, updated_at: new Date().toISOString() })
    .eq("name", name);
  if (error) throw new Error(`setFeatureFlag: ${error.message}`);

  await writeAuditLog({
    actorId: adminId,
    actorRole: "admin",
    action: "feature_flag.set",
    entityType: "feature_flags",
    entityId: name,
    metadata: { enabled },
  });
}

// ---------------------------------------------------------------------------
// Vendor drill-down
// ---------------------------------------------------------------------------

export type VendorDrillDown = {
  id: string;
  display_name: string | null;
  stripe_account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  created_at: string;
  app_count: number;
  active_sub_count: number;
  total_gmv_cents: number;
  effective_cut_bps: number;
  cut_bps_override: number | null;
};

export async function getVendorDrillDown(vendorId: string): Promise<VendorDrillDown | null> {
  const admin = createAdminClient();

  const [{ data: profile }, { count: appCount }, { data: subs }, { data: revenue }, { data: cutInfo }] =
    await Promise.all([
      admin
        .from("profiles")
        .select("id, display_name, stripe_account_id, charges_enabled, payouts_enabled, created_at")
        .eq("id", vendorId)
        .maybeSingle(),
      admin
        .from("apps")
        .select("id", { count: "exact", head: true })
        .eq("vendor_id", vendorId),
      admin
        .from("subscriptions")
        .select("id")
        .in(
          "app_id",
          // subquery workaround — fetch app IDs first
          await admin
            .from("apps")
            .select("id")
            .eq("vendor_id", vendorId)
            .then(({ data: apps }) => (apps ?? []).map((a) => a.id))
        )
        .in("status", ["active", "trialing"]),
      admin
        .from("vendor_revenue_events")
        .select("amount_cents")
        .eq("vendor_id", vendorId),
      admin.rpc("admin_get_vendors_cut_info"),
    ]);

  if (!profile) return null;

  const totalGmv = (revenue ?? []).reduce((s, r) => s + r.amount_cents, 0);
  const activeSubs = (subs ?? []).length;
  const cutRow = (cutInfo as VendorCutInfo[] | null)?.find((c) => c.vendor_id === vendorId);

  return {
    id: profile.id,
    display_name: profile.display_name,
    stripe_account_id: profile.stripe_account_id,
    charges_enabled: profile.charges_enabled,
    payouts_enabled: profile.payouts_enabled,
    created_at: profile.created_at,
    app_count: appCount ?? 0,
    active_sub_count: activeSubs,
    total_gmv_cents: totalGmv,
    effective_cut_bps: cutRow?.effective_cut_bps ?? 1200,
    cut_bps_override: cutRow?.cut_bps_override ?? null,
  };
}

// ---------------------------------------------------------------------------
// Subscription lookup (manual support tool)
// ---------------------------------------------------------------------------

export type SubDetail = {
  id: string;
  app_name: string;
  buyer_id: string;
  status: string;
  price_cents: number;
  currency: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  affiliate_id: string | null;
  reseller_id: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  current_period_end: string;
  created_at: string;
  formatted_price: string;
};

export async function lookupSubscription(subId: string): Promise<SubDetail | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("subscriptions")
    .select(
      "id, buyer_id, status, price_cents, currency, stripe_subscription_id, stripe_customer_id, affiliate_id, reseller_id, cancel_at_period_end, canceled_at, current_period_end, created_at, app_id"
    )
    .eq("id", subId)
    .maybeSingle();
  if (error) throw new Error(`lookupSubscription: ${error.message}`);
  if (!data) return null;

  const { data: app } = await admin.from("apps").select("name").eq("id", data.app_id).maybeSingle();
  return {
    ...data,
    app_name: app?.name ?? data.app_id,
    formatted_price: formatPrice(data.price_cents, data.currency),
  };
}
