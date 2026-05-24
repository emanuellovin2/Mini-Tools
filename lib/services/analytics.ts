import { createAdminClient } from "@/lib/services/supabase";
import { buildFunnel, computeEpc, aggregateSources } from "@/lib/analytics/funnel";
import type { Funnel, EpcResult, SourceRow, RollupRow } from "@/lib/analytics/funnel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = ReturnType<typeof createAdminClient> & { from: any; rpc: any };

export type EventType =
  | "impression" | "view" | "click" | "signup"
  | "checkout_start" | "checkout_complete" | "launch"
  | "storefront_visit" | "marketplace_view";

export type EntityType =
  | "app" | "offer" | "affiliate_link" | "storefront"
  | "agent" | "workflow" | "marketplace";

export interface AnalyticsEvent {
  event_type: EventType;
  entity_type: EntityType;
  entity_id: string;
  owner_org_id?: string | null;
  affiliate_id?: string | null;
  reseller_id?: string | null;
  visitor_hash?: string | null;
  session_id?: string | null;
  referrer?: string | null;
  utm?: Record<string, string> | null;
  country?: string | null;
}

// Server-side capture — fire-and-forget (no throw on insert failure).
export async function recordEvent(evt: AnalyticsEvent): Promise<void> {
  const admin = createAdminClient() as AnyClient;
  const { error } = await admin.from("analytics_events").insert(evt);
  if (error) {
    console.error(JSON.stringify({ event: "analytics.record_error", error: error.message }));
  }
}

// Batch insert (used by /api/events endpoint).
export async function recordEventsBatch(evts: AnalyticsEvent[]): Promise<void> {
  if (evts.length === 0) return;
  const admin = createAdminClient() as AnyClient;
  const { error } = await admin.from("analytics_events").insert(evts);
  if (error) {
    console.error(JSON.stringify({ event: "analytics.batch_error", count: evts.length, error: error.message }));
  }
}

// Date range helper
function dateRange(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(Date.now() - days * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

// ── Affiliate funnel ─────────────────────────────────────────────────────────

export interface AffiliateFunnelResult {
  funnel: Funnel;
  epc: EpcResult;
  // Legacy conversion-only fields (kept for backward compat with dashboard components)
  total_attributed: number;
  currently_active: number;
  active_30d: number;
  active_90d: number;
}

export async function getAffiliateFunnel(
  affiliateId: string,
  linkCode?: string,
  days = 90
): Promise<AffiliateFunnelResult> {
  const admin = createAdminClient() as AnyClient;
  const { from } = dateRange(days);

  // Rollup rows for this affiliate
  let rollupQ = admin
    .from("analytics_daily")
    .select("*")
    .eq("affiliate_id", affiliateId)
    .gte("date", from);
  if (linkCode) {
    // Map link code to entity_id via affiliate_links
    const { data: link } = await admin
      .from("affiliate_links")
      .select("id")
      .eq("code", linkCode)
      .eq("affiliate_id", affiliateId)
      .maybeSingle();
    if (link) {
      rollupQ = rollupQ.eq("entity_id", link.id).eq("entity_type", "affiliate_link");
    }
  }

  const { data: rollupRows } = await rollupQ;
  const rows: RollupRow[] = (rollupRows ?? []).map((r: Record<string, unknown>) => ({
    date: r.date as string,
    event_type: r.event_type as string,
    entity_type: r.entity_type as string,
    entity_id: r.entity_id as string,
    owner_org_id: r.owner_org_id as string | null,
    affiliate_id: r.affiliate_id as string | null,
    reseller_id: r.reseller_id as string | null,
    event_count: Number(r.event_count),
    unique_visitors: Number(r.unique_visitors),
  }));

  const funnel = buildFunnel(rows, [
    { label: "Clicks",          event_type: "click" },
    { label: "Signups",         event_type: "signup" },
    { label: "Checkout starts", event_type: "checkout_start" },
    { label: "Subscribed",      event_type: "checkout_complete" },
  ]);

  // Conversion count from subscriptions (ground-truth)
  const now = new Date();
  const t30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const t90 = new Date(now.getTime() - 90 * 86_400_000).toISOString();

  let convQ = admin
    .from("subscriptions")
    .select("id, status, created_at, affiliate_links!inner(code, affiliate_id)")
    .eq("affiliate_links.affiliate_id", affiliateId);
  if (linkCode) convQ = convQ.eq("affiliate_links.code", linkCode);
  const { data: convData } = await convQ;
  const convRows = convData ?? [];
  const active = convRows.filter(
    (r: Record<string, string>) => r.status === "active" || r.status === "trialing"
  );

  // Commission total for EPC
  const { data: commData } = await admin
    .from("vendor_revenue_events")
    .select("affiliate_share_cents")
    .eq("affiliate_id", affiliateId)
    .gte("created_at", new Date(Date.now() - days * 86_400_000).toISOString())
    .gt("affiliate_share_cents", 0);
  const totalCommission = (commData ?? []).reduce(
    (sum: number, r: { affiliate_share_cents: number }) => sum + (r.affiliate_share_cents ?? 0),
    0
  );

  const clickRows = rows.filter((r) => r.event_type === "click");
  const epc = computeEpc(clickRows, convRows.length, totalCommission);

  return {
    funnel,
    epc,
    total_attributed: convRows.length,
    currently_active: active.length,
    active_30d: active.filter((r: Record<string, string>) => r.created_at <= t30).length,
    active_90d: active.filter((r: Record<string, string>) => r.created_at <= t90).length,
  };
}

// ── Reseller offer funnel ────────────────────────────────────────────────────

export interface OfferFunnelResult {
  funnel: Funnel;
  traffic_sources: SourceRow[];
  // Conversion-only legacy fields
  total_subs: number;
  active_subs: number;
  churned_subs: number;
  paused_subs: number;
  mrr_cents: number;
  churn_rate_pct: number;
  refund_count: number;
  refund_amount_cents: number;
}

export async function getOfferFunnel(
  resellerId: string,
  offerId: string,
  days = 90
): Promise<OfferFunnelResult> {
  const admin = createAdminClient() as AnyClient;
  const { from } = dateRange(days);

  // Verify offer ownership
  const { data: offerCheck } = await admin
    .from("reseller_offers")
    .select("id")
    .eq("id", offerId)
    .eq("reseller_id", resellerId)
    .maybeSingle();

  const empty: OfferFunnelResult = {
    funnel: { stages: [], overall_conversion_pct: null },
    traffic_sources: [],
    total_subs: 0, active_subs: 0, churned_subs: 0, paused_subs: 0,
    mrr_cents: 0, churn_rate_pct: 0, refund_count: 0, refund_amount_cents: 0,
  };
  if (!offerCheck) return empty;

  const { data: rollupRows } = await admin
    .from("analytics_daily")
    .select("*")
    .eq("reseller_id", resellerId)
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .gte("date", from);

  const rows: RollupRow[] = (rollupRows ?? []).map((r: Record<string, unknown>) => ({
    date: r.date as string,
    event_type: r.event_type as string,
    entity_type: r.entity_type as string,
    entity_id: r.entity_id as string,
    owner_org_id: r.owner_org_id as string | null,
    affiliate_id: r.affiliate_id as string | null,
    reseller_id: r.reseller_id as string | null,
    event_count: Number(r.event_count),
    unique_visitors: Number(r.unique_visitors),
  }));

  const funnel = buildFunnel(rows, [
    { label: "Storefront visits",  event_type: "storefront_visit" },
    { label: "Checkout starts",    event_type: "checkout_start" },
    { label: "Subscribed",         event_type: "checkout_complete" },
  ]);

  // Traffic sources from raw events (30d window for granularity)
  const { data: rawRows } = await admin
    .from("analytics_events")
    .select("referrer, event_count:id.count(), unique_visitors:visitor_hash.count()")
    .eq("reseller_id", resellerId)
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .eq("event_type", "storefront_visit")
    .gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString());

  const traffic_sources = aggregateSources(
    (rawRows ?? []).map((r: Record<string, unknown>) => ({
      referrer: r.referrer as string | null,
      event_count: Number(r.event_count ?? 0),
      unique_visitors: Number(r.unique_visitors ?? 0),
    }))
  );

  // Sub-level stats (subscription table — ground truth)
  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, status, price_cents")
    .eq("reseller_offer_id", offerId);
  const subRows = subs ?? [];
  const active = subRows.filter((s: Record<string, string>) => s.status === "active" || s.status === "trialing");
  const churned = subRows.filter((s: Record<string, string>) => s.status === "canceled");
  const paused = subRows.filter((s: Record<string, string>) => s.status === "paused");
  const mrr_cents = active.reduce((sum: number, s: Record<string, number>) => sum + s.price_cents, 0);
  const churn_rate_pct = subRows.length > 0 ? parseFloat(((churned.length / subRows.length) * 100).toFixed(2)) : 0;

  const subIds = subRows.map((s: Record<string, string>) => s.id);
  let refund_count = 0;
  let refund_amount_cents = 0;
  if (subIds.length > 0) {
    const { data: refunds } = await admin
      .from("vendor_revenue_events")
      .select("amount_cents")
      .in("subscription_id", subIds)
      .lt("amount_cents", 0);
    refund_count = (refunds ?? []).length;
    refund_amount_cents = (refunds ?? []).reduce(
      (sum: number, e: { amount_cents: number }) => sum + Math.abs(e.amount_cents),
      0
    );
  }

  return {
    funnel,
    traffic_sources,
    total_subs: subRows.length,
    active_subs: active.length,
    churned_subs: churned.length,
    paused_subs: paused.length,
    mrr_cents,
    churn_rate_pct,
    refund_count,
    refund_amount_cents,
  };
}

// ── Vendor funnel ────────────────────────────────────────────────────────────

export interface VendorFunnelResult {
  funnel: Funnel;
  by_app: Array<{ app_id: string; app_name: string; funnel: Funnel }>;
}

export async function getVendorFunnel(orgId: string, days = 90): Promise<VendorFunnelResult> {
  const admin = createAdminClient() as AnyClient;
  const { from } = dateRange(days);

  const { data: rollupRows } = await admin
    .from("analytics_daily")
    .select("*")
    .eq("owner_org_id", orgId)
    .eq("entity_type", "app")
    .gte("date", from);

  const rows: RollupRow[] = (rollupRows ?? []).map((r: Record<string, unknown>) => ({
    date: r.date as string,
    event_type: r.event_type as string,
    entity_type: r.entity_type as string,
    entity_id: r.entity_id as string,
    owner_org_id: r.owner_org_id as string | null,
    affiliate_id: r.affiliate_id as string | null,
    reseller_id: r.reseller_id as string | null,
    event_count: Number(r.event_count),
    unique_visitors: Number(r.unique_visitors),
  }));

  const stageTypes = [
    { label: "Impressions",    event_type: "impression" },
    { label: "App views",      event_type: "view" },
    { label: "Checkout start", event_type: "checkout_start" },
    { label: "Subscribed",     event_type: "checkout_complete" },
  ];
  const funnel = buildFunnel(rows, stageTypes);

  // Per-app breakdown
  const appIds = [...new Set(rows.map((r) => r.entity_id))];
  const { data: appsData } = await admin.from("apps").select("id, name").in("id", appIds);
  const appMap = new Map<string, string>((appsData ?? []).map((a: { id: string; name: string }) => [a.id, a.name]));

  const by_app = appIds.map((appId) => ({
    app_id: appId,
    app_name: appMap.get(appId) ?? appId,
    funnel: buildFunnel(rows.filter((r) => r.entity_id === appId), stageTypes),
  }));

  return { funnel, by_app };
}

// ── Admin acquisition funnel ──────────────────────────────────────────────────

export interface AdminFunnelResult {
  funnel: Funnel;
  channel_breakdown: Record<string, { clicks: number; conversions: number }>;
}

export async function getAdminFunnel(days = 30): Promise<AdminFunnelResult> {
  const admin = createAdminClient() as AnyClient;
  const { from } = dateRange(days);

  const { data: rollupRows } = await admin
    .from("analytics_daily")
    .select("*")
    .gte("date", from);

  const rows: RollupRow[] = (rollupRows ?? []).map((r: Record<string, unknown>) => ({
    date: r.date as string,
    event_type: r.event_type as string,
    entity_type: r.entity_type as string,
    entity_id: r.entity_id as string,
    owner_org_id: r.owner_org_id as string | null,
    affiliate_id: r.affiliate_id as string | null,
    reseller_id: r.reseller_id as string | null,
    event_count: Number(r.event_count),
    unique_visitors: Number(r.unique_visitors),
  }));

  const funnel = buildFunnel(rows, [
    { label: "Marketplace views",  event_type: "marketplace_view" },
    { label: "App views",          event_type: "view" },
    { label: "Checkout starts",    event_type: "checkout_start" },
    { label: "Subscribed",         event_type: "checkout_complete" },
  ]);

  const channel_breakdown: Record<string, { clicks: number; conversions: number }> = {
    direct:   { clicks: 0, conversions: 0 },
    affiliate: { clicks: 0, conversions: 0 },
    reseller:  { clicks: 0, conversions: 0 },
  };
  for (const row of rows) {
    const ch = row.affiliate_id ? "affiliate" : row.reseller_id ? "reseller" : "direct";
    if (row.event_type === "click") channel_breakdown[ch].clicks += row.unique_visitors;
    if (row.event_type === "checkout_complete") channel_breakdown[ch].conversions += row.event_count;
  }

  return { funnel, channel_breakdown };
}

// ── EPC per affiliate ─────────────────────────────────────────────────────────

export async function getEpc(affiliateId: string, days = 90): Promise<EpcResult> {
  const admin = createAdminClient() as AnyClient;
  const { from } = dateRange(days);

  const { data: clickRows } = await admin
    .from("analytics_daily")
    .select("*")
    .eq("affiliate_id", affiliateId)
    .eq("event_type", "click")
    .gte("date", from);

  const rows: RollupRow[] = (clickRows ?? []).map((r: Record<string, unknown>) => ({
    date: r.date as string,
    event_type: r.event_type as string,
    entity_type: r.entity_type as string,
    entity_id: r.entity_id as string,
    owner_org_id: r.owner_org_id as string | null,
    affiliate_id: r.affiliate_id as string | null,
    reseller_id: r.reseller_id as string | null,
    event_count: Number(r.event_count),
    unique_visitors: Number(r.unique_visitors),
  }));

  const { data: convData } = await admin
    .from("subscriptions")
    .select("id")
    .eq("affiliate_id", affiliateId)
    .gte("created_at", new Date(Date.now() - days * 86_400_000).toISOString());

  const { data: commData } = await admin
    .from("vendor_revenue_events")
    .select("affiliate_share_cents")
    .eq("affiliate_id", affiliateId)
    .gte("created_at", new Date(Date.now() - days * 86_400_000).toISOString())
    .gt("affiliate_share_cents", 0);

  const totalComm = (commData ?? []).reduce(
    (sum: number, r: { affiliate_share_cents: number }) => sum + (r.affiliate_share_cents ?? 0),
    0
  );

  return computeEpc(rows, (convData ?? []).length, totalComm);
}

// ── Traffic sources per reseller offer ───────────────────────────────────────

export async function getTrafficSources(
  offerId: string,
  days = 30
): Promise<SourceRow[]> {
  const admin = createAdminClient() as AnyClient;
  const { data: rawRows } = await admin
    .from("analytics_events")
    .select("referrer, event_count:id, unique_visitors:visitor_hash")
    .eq("entity_id", offerId)
    .eq("event_type", "storefront_visit")
    .gte("created_at", new Date(Date.now() - days * 86_400_000).toISOString());

  return aggregateSources(
    (rawRows ?? []).map((r: Record<string, unknown>) => ({
      referrer: r.referrer as string | null,
      event_count: 1,
      unique_visitors: r.unique_visitors ? 1 : 0,
    }))
  );
}

// ── Rollup day (called by cron) ───────────────────────────────────────────────

export async function rollupDay(date: Date): Promise<void> {
  const admin = createAdminClient() as AnyClient;
  const dateStr = date.toISOString().slice(0, 10);
  const { error } = await admin.rpc("rollup_analytics_day", { p_date: dateStr });
  if (error) throw new Error(`rollup_analytics_day failed for ${dateStr}: ${error.message}`);
}
