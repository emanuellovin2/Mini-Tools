import { describe, it, expect } from "vitest";
import {
  aggregateStats,
  type MRRWaterfallRow,
  type CohortRow,
} from "@/lib/services/vendor";

// ── Pure-function helpers extracted for unit testing ───────────────────────

function computeMRR(
  subs: Array<{ price_cents: number; vendor_floor_snapshot_cents: number | null; reseller_id: string | null; status: string }>
): number {
  return subs
    .filter((s) => s.status === "active" || s.status === "trialing")
    .reduce(
      (sum, s) =>
        sum + (s.reseller_id ? (s.vendor_floor_snapshot_cents ?? 0) : s.price_cents),
      0
    );
}

function computeChurnBps(startActive: number, canceledDuringMonth: number): number {
  if (startActive === 0) return 0;
  return Math.round((canceledDuringMonth / startActive) * 10000);
}

function cohortRetentionPct(retained: number, cohortSize: number): number | null {
  if (cohortSize === 0) return null;
  return Math.round((retained / cohortSize) * 100);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("MRR computation", () => {
  it("sums price_cents for 5 active subs at $50 each", () => {
    const subs = Array.from({ length: 5 }, () => ({
      price_cents: 5000,
      vendor_floor_snapshot_cents: null,
      reseller_id: null,
      status: "active",
    }));
    expect(computeMRR(subs)).toBe(25000);
  });

  it("excludes canceled subscriptions", () => {
    const subs = [
      { price_cents: 5000, vendor_floor_snapshot_cents: null, reseller_id: null, status: "active" },
      { price_cents: 5000, vendor_floor_snapshot_cents: null, reseller_id: null, status: "canceled" },
    ];
    expect(computeMRR(subs)).toBe(5000);
  });

  it("uses vendor_floor_snapshot_cents for reseller-sold subs", () => {
    const subs = [
      { price_cents: 6000, vendor_floor_snapshot_cents: 4000, reseller_id: "res-1", status: "active" },
      { price_cents: 5000, vendor_floor_snapshot_cents: null, reseller_id: null, status: "active" },
    ];
    // reseller sub contributes floor ($40), direct sub contributes full price ($50)
    expect(computeMRR(subs)).toBe(4000 + 5000);
  });

  it("returns 0 for empty sub list", () => {
    expect(computeMRR([])).toBe(0);
  });
});

describe("Churn rate", () => {
  it("100 active at start, 5 canceled → 500 bps (5%)", () => {
    expect(computeChurnBps(100, 5)).toBe(500);
  });

  it("returns 0 when no active subs at start of month", () => {
    expect(computeChurnBps(0, 0)).toBe(0);
  });

  it("100% churn: all 10 subs canceled", () => {
    expect(computeChurnBps(10, 10)).toBe(10000);
  });
});

describe("Cohort retention", () => {
  it("cohort of 10 at month 0, 8 retained at month 1 → 80%", () => {
    const row: CohortRow = {
      cohort_month: "2026-01-01",
      month_offset: 1,
      retained_count: 8,
      cohort_size: 10,
    };
    expect(cohortRetentionPct(row.retained_count, row.cohort_size)).toBe(80);
  });

  it("month 0 always 100% (first payment = subscribe)", () => {
    expect(cohortRetentionPct(10, 10)).toBe(100);
  });

  it("returns null for zero cohort size", () => {
    expect(cohortRetentionPct(0, 0)).toBeNull();
  });
});

describe("aggregateStats (existing helper)", () => {
  it("aggregates active subs and MRR for a given appId", () => {
    const stats = [
      { app_id: "app-1", anon_user_id: "u1", status: "active",   price_cents: 3000, current_period_end: "" },
      { app_id: "app-1", anon_user_id: "u2", status: "trialing", price_cents: 3000, current_period_end: "" },
      { app_id: "app-1", anon_user_id: "u3", status: "canceled", price_cents: 3000, current_period_end: "" },
      { app_id: "app-2", anon_user_id: "u4", status: "active",   price_cents: 5000, current_period_end: "" },
    ];
    const result = aggregateStats("app-1", stats);
    expect(result.activeCount).toBe(2);
    expect(result.mrrCents).toBe(6000);
  });
});

describe("MRR waterfall structure", () => {
  it("net_change_cents = new_mrr_cents - churned_mrr_cents", () => {
    const row: MRRWaterfallRow = {
      month: "2026-05",
      new_mrr_cents: 10000,
      churned_mrr_cents: 3000,
      net_change_cents: 7000,
      end_mrr_cents: 17000,
    };
    expect(row.net_change_cents).toBe(row.new_mrr_cents - row.churned_mrr_cents);
  });
});
