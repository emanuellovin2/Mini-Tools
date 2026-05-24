import { createAdminClient } from "./supabase";
import { createServerSupabaseClient } from "./supabase-server";
import { getStripe } from "@/lib/stripe/client";
import { VENDOR_WL_KICKBACK_BPS } from "@/lib/stripe/transfers";
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

// ── Dashboard v2 types & helpers (#32) ──────────────────────────────────────

export type ChannelMix = {
  direct_cents: number;
  direct_count: number;
  affiliate_cents: number;
  affiliate_count: number;
  reseller_cents: number;
  reseller_count: number;
  total_cents: number;
};

export type VendorBalance = {
  available_cents: number;
  pending_cents: number;
  currency: string;
  connected: boolean;
};

export type DunningItem = {
  id: string;
  anon_user_id: string;
  app_id: string;
  app_name: string;
  price_cents: number;
  current_period_end: string;
  stripe_subscription_id: string;
};

export type DunningResult = {
  count: number;
  at_risk_cents: number;
  items: DunningItem[];
};

export type RefundEvent = {
  id: string;
  date: string;
  type: "refund" | "dispute";
  amount_cents: number;
  description: string;
};

export type RefundsFeed = {
  refund_count: number;
  refund_cents: number;
  dispute_count: number;
  dispute_cents: number;
  events: RefundEvent[];
};

export type ResellerKickbackRow = {
  reseller_id: string;
  slug: string | null;
  kickback_cents: number;
  sale_count: number;
};

export type ResellerKickbackResult = {
  total_kickback_cents: number;
  by_reseller: ResellerKickbackRow[];
};

export type AppDrillDown = {
  mrr: MRRSnapshot;
  churn_bps: number;
  ltv: LTVResult;
  channel_mix: ChannelMix;
};

// Channel mix for active subscriptions — classifies by affiliate_id / reseller_id flags.
export async function getVendorChannelMix(
  vendorId: string,
  appId?: string
): Promise<ChannelMix> {
  const admin = createAdminClient();
  let query = admin
    .from("subscriptions")
    .select(
      "price_cents, vendor_floor_snapshot_cents, affiliate_id, reseller_id, apps!inner(vendor_id)"
    )
    .eq("apps.vendor_id", vendorId)
    .in("status", ["active", "trialing"]);
  if (appId) query = query.eq("app_id", appId);

  const { data, error } = await query;
  if (error) throw error;

  let direct_cents = 0, direct_count = 0;
  let affiliate_cents = 0, affiliate_count = 0;
  let reseller_cents = 0, reseller_count = 0;

  for (const row of data ?? []) {
    if (row.reseller_id) {
      reseller_cents += row.vendor_floor_snapshot_cents ?? 0;
      reseller_count++;
    } else if (row.affiliate_id) {
      affiliate_cents += row.price_cents;
      affiliate_count++;
    } else {
      direct_cents += row.price_cents;
      direct_count++;
    }
  }

  return {
    direct_cents, direct_count,
    affiliate_cents, affiliate_count,
    reseller_cents, reseller_count,
    total_cents: direct_cents + affiliate_cents + reseller_cents,
  };
}

// Stripe Connect balance for the vendor's connected account.
export async function getVendorBalance(vendorId: string): Promise<VendorBalance> {
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", vendorId)
    .maybeSingle();

  if (!profile?.stripe_account_id) {
    return { available_cents: 0, pending_cents: 0, currency: "usd", connected: false };
  }

  try {
    const stripe = getStripe();
    const balance = await stripe.balance.retrieve(
      {},
      { stripeAccount: profile.stripe_account_id }
    );
    const available = balance.available.reduce((sum, b) => sum + b.amount, 0);
    const pending = balance.pending.reduce((sum, b) => sum + b.amount, 0);
    return {
      available_cents: available,
      pending_cents: pending,
      currency: balance.available[0]?.currency ?? "usd",
      connected: true,
    };
  } catch {
    return { available_cents: 0, pending_cents: 0, currency: "usd", connected: false };
  }
}

// Past-due subscriptions for this vendor (dunning queue).
export async function getVendorDunning(vendorId: string): Promise<DunningResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("subscriptions")
    .select(
      "id, anon_user_id, app_id, price_cents, current_period_end, stripe_subscription_id, apps!inner(vendor_id, name)"
    )
    .eq("apps.vendor_id", vendorId)
    .eq("status", "past_due");
  if (error) throw error;

  const items: DunningItem[] = (data ?? []).map((row) => ({
    id: row.id,
    anon_user_id: row.anon_user_id,
    app_id: row.app_id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app_name: (row.apps as any)?.name ?? "Unknown",
    price_cents: row.price_cents,
    current_period_end: row.current_period_end,
    stripe_subscription_id: row.stripe_subscription_id,
  }));

  return {
    count: items.length,
    at_risk_cents: items.reduce((sum, i) => sum + i.price_cents, 0),
    items,
  };
}

// Recent refunds & disputes from the vendor's Stripe Connect account balance transactions.
export async function getVendorRefundsDisputes(
  vendorId: string,
  days = 30
): Promise<RefundsFeed> {
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", vendorId)
    .maybeSingle();

  const empty: RefundsFeed = {
    refund_count: 0, refund_cents: 0,
    dispute_count: 0, dispute_cents: 0,
    events: [],
  };

  if (!profile?.stripe_account_id) return empty;

  try {
    const stripe = getStripe();
    const since = Math.floor(Date.now() / 1000) - days * 86400;

    const [refundTxns, disputeTxns] = await Promise.all([
      stripe.balanceTransactions.list(
        { limit: 50, created: { gte: since }, type: "payment_refund" },
        { stripeAccount: profile.stripe_account_id }
      ),
      stripe.balanceTransactions.list(
        { limit: 50, created: { gte: since }, type: "adjustment" },
        { stripeAccount: profile.stripe_account_id }
      ),
    ]);

    const refundEvents: RefundEvent[] = refundTxns.data.map((t) => ({
      id: t.id,
      date: new Date(t.created * 1000).toISOString(),
      type: "refund" as const,
      amount_cents: Math.abs(t.amount),
      description: t.description ?? "Refund",
    }));

    const disputeEvents: RefundEvent[] = disputeTxns.data
      .filter((t) => t.amount < 0)
      .map((t) => ({
        id: t.id,
        date: new Date(t.created * 1000).toISOString(),
        type: "dispute" as const,
        amount_cents: Math.abs(t.amount),
        description: t.description ?? "Dispute adjustment",
      }));

    const events = [...refundEvents, ...disputeEvents].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    return {
      refund_count: refundEvents.length,
      refund_cents: refundEvents.reduce((s, e) => s + e.amount_cents, 0),
      dispute_count: disputeEvents.length,
      dispute_cents: disputeEvents.reduce((s, e) => s + e.amount_cents, 0),
      events,
    };
  } catch {
    return empty;
  }
}

// Kickback earned by this vendor from Tier 2 WL reseller sales (open_to_wl only).
// Estimated from active subs: markup × 2.5% × 33.33%.
export async function getVendorResellerKickback(
  vendorId: string
): Promise<ResellerKickbackResult> {
  const admin = createAdminClient();
  // reseller_openness is not yet reflected in auto-generated types — select via raw cast
  const { data: profile } = await admin
    .from("profiles")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("reseller_openness" as any)
    .eq("id", vendorId)
    .maybeSingle() as { data: { reseller_openness: string | null } | null };

  if (profile?.reseller_openness !== "open_to_wl") {
    return { total_kickback_cents: 0, by_reseller: [] };
  }

  const { data, error } = await admin
    .from("subscriptions")
    .select(
      "vendor_floor_snapshot_cents, reseller_id, reseller_offer_id, apps!inner(vendor_id)"
    )
    .eq("apps.vendor_id", vendorId)
    .not("reseller_id", "is", null)
    .in("status", ["active", "trialing"]);
  if (error) throw error;

  const rows = data ?? [];
  const offerIds = [...new Set(rows.map((r) => r.reseller_offer_id).filter(Boolean))] as string[];
  if (!offerIds.length) return { total_kickback_cents: 0, by_reseller: [] };

  const { data: offers } = await admin
    .from("reseller_offers")
    .select("id, sell_price_cents, reseller_id")
    .in("id", offerIds);

  const offerMap = new Map((offers ?? []).map((o) => [o.id, o]));

  const resellerIds = [...new Set(rows.map((r) => r.reseller_id).filter(Boolean))] as string[];
  const { data: rProfiles } = await admin
    .from("profiles")
    .select("id, slug")
    .in("id", resellerIds);
  const profileMap = new Map((rProfiles ?? []).map((p) => [p.id, p]));

  const kickbackMap = new Map<string, { kickback_cents: number; sale_count: number }>();
  let total = 0;

  for (const sub of rows) {
    if (!sub.reseller_id || !sub.reseller_offer_id) continue;
    const offer = offerMap.get(sub.reseller_offer_id);
    if (!offer) continue;

    const markup = offer.sell_price_cents - (sub.vendor_floor_snapshot_cents ?? 0);
    if (markup <= 0) continue;

    // Tier 2 platform commission = 2.5% of markup
    const platformCommission = Math.floor((markup * 250) / 10_000);
    const kickback = Math.floor((platformCommission * VENDOR_WL_KICKBACK_BPS) / 10_000);
    total += kickback;

    const existing = kickbackMap.get(sub.reseller_id) ?? { kickback_cents: 0, sale_count: 0 };
    kickbackMap.set(sub.reseller_id, {
      kickback_cents: existing.kickback_cents + kickback,
      sale_count: existing.sale_count + 1,
    });
  }

  const by_reseller: ResellerKickbackRow[] = [...kickbackMap.entries()].map(
    ([rid, stats]) => ({
      reseller_id: rid,
      slug: profileMap.get(rid)?.slug ?? null,
      kickback_cents: stats.kickback_cents,
      sale_count: stats.sale_count,
    })
  );

  return { total_kickback_cents: total, by_reseller };
}

// Per-app drill-down: MRR + churn + LTV + channel mix for one specific app.
export async function getVendorAppDrillDown(
  vendorId: string,
  appId: string
): Promise<AppDrillDown> {
  const [mrr, churn_bps, ltv, channel_mix] = await Promise.all([
    getVendorMRR(vendorId, appId),
    getVendorChurnRate(vendorId, new Date(), appId),
    getVendorLTV(vendorId),
    getVendorChannelMix(vendorId, appId),
  ]);
  return { mrr, churn_bps, ltv, channel_mix };
}
