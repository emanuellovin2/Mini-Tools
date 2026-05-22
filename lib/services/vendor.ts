import { createAdminClient } from "./supabase";
import { createServerSupabaseClient } from "./supabase-server";
import type { Database } from "@/types/supabase";

export type MRRSnapshot = {
  mrr_cents: number;
  active_subs: number;
  arpu_cents: number;
};

export type MRRWaterfallRow = {
  month: string;           // "YYYY-MM"
  new_mrr_cents: number;
  churned_mrr_cents: number;
  net_change_cents: number;
  end_mrr_cents: number;
};

export type CohortRow = {
  cohort_month: string;   // "YYYY-MM-DD"
  month_offset: number;
  retained_count: number;
  cohort_size: number;
};

export type LTVResult = {
  avg_ltv_cents: number;
  method: string;
  data_sparse: boolean;   // true when < 6 months of data
};

export type VendorApp = Database["public"]["Tables"]["apps"]["Row"];

export type VendorSubscriptionStat = {
  app_id: string;
  anon_user_id: string;
  status: string;
  price_cents: number;
  current_period_end: string;
};

export async function getVendorApps(vendorId: string): Promise<VendorApp[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("apps")
    .select("*")
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getVendorStats(): Promise<VendorSubscriptionStat[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("vendor_subscription_stats");
  if (error) throw error;
  return (data ?? []) as VendorSubscriptionStat[];
}

// ── Analytics helpers (#24) ──────────────────────────────────────────────────

// Current MRR: direct + affiliate subs use price_cents; reseller-sold use floor snapshot.
// Excludes reseller-sold from MRR total per SPEC §3 (vendor gets floor, tracked separately).
export async function getVendorMRR(
  vendorId: string,
  appId?: string
): Promise<MRRSnapshot> {
  const admin = createAdminClient();
  let query = admin
    .from("subscriptions")
    .select("price_cents, vendor_floor_snapshot_cents, reseller_id, app_id, apps!inner(vendor_id)")
    .eq("apps.vendor_id", vendorId)
    .in("status", ["active", "trialing"]);
  if (appId) query = query.eq("app_id", appId);

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  let mrr_cents = 0;
  for (const row of rows) {
    if (row.reseller_id) {
      mrr_cents += row.vendor_floor_snapshot_cents ?? 0;
    } else {
      mrr_cents += row.price_cents;
    }
  }
  const active_subs = rows.length;
  return {
    mrr_cents,
    active_subs,
    arpu_cents: active_subs > 0 ? Math.round(mrr_cents / active_subs) : 0,
  };
}

// MRR waterfall for the last `months` calendar months.
// New MRR = subs first created in that month; Churned MRR = subs canceled in that month.
export async function getVendorMRRWaterfall(
  vendorId: string,
  months = 6,
  appId?: string
): Promise<MRRWaterfallRow[]> {
  const admin = createAdminClient();

  // Fetch all subs (created or canceled within the window) for this vendor
  const windowStart = new Date();
  windowStart.setMonth(windowStart.getMonth() - months);
  windowStart.setDate(1);
  windowStart.setHours(0, 0, 0, 0);

  let query = admin
    .from("subscriptions")
    .select("price_cents, vendor_floor_snapshot_cents, reseller_id, created_at, canceled_at, app_id, apps!inner(vendor_id)")
    .eq("apps.vendor_id", vendorId);
  if (appId) query = query.eq("app_id", appId);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data ?? [];

  const effectivePrice = (row: typeof rows[0]) =>
    row.reseller_id ? (row.vendor_floor_snapshot_cents ?? 0) : row.price_cents;

  // Build a map of month → { new, churned }
  const buckets = new Map<string, { new_mrr: number; churned_mrr: number }>();
  const monthKeys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    buckets.set(key, { new_mrr: 0, churned_mrr: 0 });
    monthKeys.push(key);
  }

  for (const row of rows) {
    const price = effectivePrice(row);
    if (row.created_at) {
      const d = new Date(row.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.new_mrr += price;
    }
    if (row.canceled_at) {
      const d = new Date(row.canceled_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.churned_mrr += price;
    }
  }

  // Compute running end_mrr
  let running = 0;
  return monthKeys.map((month) => {
    const b = buckets.get(month)!;
    const net = b.new_mrr - b.churned_mrr;
    running += net;
    return {
      month,
      new_mrr_cents: b.new_mrr,
      churned_mrr_cents: b.churned_mrr,
      net_change_cents: net,
      end_mrr_cents: Math.max(0, running),
    };
  });
}

// Monthly churn rate in bps (canceled / start-of-month active × 10000).
// Returns 0 when there are no active subs at the start of the month.
export async function getVendorChurnRate(
  vendorId: string,
  month: Date,
  appId?: string
): Promise<number> {
  const admin = createAdminClient();
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
  const monthEnd   = new Date(month.getFullYear(), month.getMonth() + 1, 1);

  let baseQuery = admin
    .from("subscriptions")
    .select("created_at, canceled_at, status, apps!inner(vendor_id)")
    .eq("apps.vendor_id", vendorId);
  if (appId) baseQuery = baseQuery.eq("app_id", appId);
  const { data, error } = await baseQuery;
  if (error) throw error;
  const rows = data ?? [];

  // Start-of-month active: created before monthStart, not canceled before monthStart
  const startActive = rows.filter((r) => {
    const created = new Date(r.created_at);
    if (created >= monthStart) return false;
    if (!r.canceled_at) return true;
    return new Date(r.canceled_at) >= monthStart;
  }).length;

  if (startActive === 0) return 0;

  // Canceled during the month
  const canceled = rows.filter((r) => {
    if (!r.canceled_at) return false;
    const d = new Date(r.canceled_at);
    return d >= monthStart && d < monthEnd;
  }).length;

  return Math.round((canceled / startActive) * 10000);
}

// Cohort retention from the DB RPC. Application layer must verify vendorId = auth user.
export async function getVendorCohortRetention(vendorId: string): Promise<CohortRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("vendor_cohort_retention", {
    p_vendor_id: vendorId,
  });
  if (error) throw error;
  return (data ?? []) as unknown as CohortRow[];
}

// LTV estimate: avg_price / monthly_churn_rate (cohort-agnostic).
// data_sparse = true when vendor has < 6 months of first data.
export async function getVendorLTV(vendorId: string): Promise<LTVResult> {
  const admin = createAdminClient();

  // Oldest sub for this vendor
  const { data: oldest } = await admin
    .from("subscriptions")
    .select("created_at, apps!inner(vendor_id)")
    .eq("apps.vendor_id", vendorId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const monthsOfData = oldest?.created_at
    ? Math.floor(
        (Date.now() - new Date(oldest.created_at).getTime()) /
          (1000 * 60 * 60 * 24 * 30)
      )
    : 0;

  const { mrr_cents, active_subs } = await getVendorMRR(vendorId);
  const churnBps = await getVendorChurnRate(vendorId, new Date());

  const avgPriceCents = active_subs > 0 ? mrr_cents / active_subs : 0;
  const monthlyChurnRate = churnBps / 10000;

  const avg_ltv_cents =
    monthlyChurnRate > 0 ? Math.round(avgPriceCents / monthlyChurnRate) : 0;

  return {
    avg_ltv_cents,
    method: "avg_price / monthly_churn_rate",
    data_sparse: monthsOfData < 6,
  };
}

// ── Aggregate MRR and active subscriber count per app from stats (no buyer identity) ──
export function aggregateStats(
  appId: string,
  stats: VendorSubscriptionStat[]
): { activeCount: number; mrrCents: number } {
  const active = stats.filter(
    (s) =>
      s.app_id === appId &&
      (s.status === "active" || s.status === "trialing")
  );
  return {
    activeCount: active.length,
    mrrCents: active.reduce((sum, s) => sum + s.price_cents, 0),
  };
}
