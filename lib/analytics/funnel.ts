// Pure aggregation helpers — no DB calls.
// Consume rollup rows (analytics_daily) to produce funnel/EPC/conversion shapes.

export interface RollupRow {
  date: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  owner_org_id: string | null;
  affiliate_id: string | null;
  reseller_id: string | null;
  event_count: number;
  unique_visitors: number;
}

export interface FunnelStage {
  label: string;
  event_type: string;
  count: number;
  unique_visitors: number;
  conversion_pct: number | null; // relative to previous stage
}

export interface Funnel {
  stages: FunnelStage[];
  overall_conversion_pct: number | null; // top → bottom
}

// Build a conversion funnel from rollup rows filtered to the given event_types (in order).
export function buildFunnel(rows: RollupRow[], stageTypes: { label: string; event_type: string }[]): Funnel {
  const totals = new Map<string, { count: number; visitors: number }>();
  for (const row of rows) {
    const cur = totals.get(row.event_type) ?? { count: 0, visitors: 0 };
    totals.set(row.event_type, {
      count: cur.count + row.event_count,
      visitors: cur.visitors + row.unique_visitors,
    });
  }

  const stages: FunnelStage[] = stageTypes.map(({ label, event_type }, i) => {
    const cur = totals.get(event_type) ?? { count: 0, visitors: 0 };
    let conversion_pct: number | null = null;
    if (i > 0) {
      const prevType = stageTypes[i - 1].event_type;
      const prev = totals.get(prevType);
      if (prev && prev.visitors > 0) {
        conversion_pct = parseFloat(((cur.visitors / prev.visitors) * 100).toFixed(2));
      }
    }
    return { label, event_type, count: cur.count, unique_visitors: cur.visitors, conversion_pct };
  });

  const top = stages[0]?.unique_visitors ?? 0;
  const bottom = stages[stages.length - 1]?.unique_visitors ?? 0;
  const overall_conversion_pct =
    stages.length >= 2 && top > 0
      ? parseFloat(((bottom / top) * 100).toFixed(2))
      : null;

  return { stages, overall_conversion_pct };
}

export interface EpcResult {
  clicks: number;
  conversions: number;
  total_commission_cents: number;
  epc_cents: number | null; // earnings per click (null if no clicks)
  click_to_sale_pct: number | null;
}

// Earnings per click from rollup rows + commission data.
export function computeEpc(
  clickRows: RollupRow[],
  conversions: number,
  total_commission_cents: number
): EpcResult {
  const clicks = clickRows.reduce((sum, r) => sum + r.unique_visitors, 0);
  const epc_cents = clicks > 0 ? Math.round(total_commission_cents / clicks) : null;
  const click_to_sale_pct =
    clicks > 0 ? parseFloat(((conversions / clicks) * 100).toFixed(2)) : null;
  return { clicks, conversions, total_commission_cents, epc_cents, click_to_sale_pct };
}

export interface SourceRow {
  referrer: string | null;
  visits: number;
  unique_visitors: number;
}

// Summarise traffic sources from raw event rows that carry `referrer`.
// (Used for reseller storefront traffic analysis.)
export function aggregateSources(
  rows: Array<{ referrer: string | null; event_count: number; unique_visitors: number }>
): SourceRow[] {
  const map = new Map<string, { visits: number; unique_visitors: number }>();
  for (const row of rows) {
    const key = row.referrer ?? "(direct)";
    const cur = map.get(key) ?? { visits: 0, unique_visitors: 0 };
    map.set(key, {
      visits: cur.visits + row.event_count,
      unique_visitors: cur.unique_visitors + row.unique_visitors,
    });
  }
  return Array.from(map.entries())
    .map(([referrer, v]) => ({ referrer, ...v }))
    .sort((a, b) => b.visits - a.visits);
}
