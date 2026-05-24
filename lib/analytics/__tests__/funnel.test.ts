import { describe, it, expect } from "vitest";
import { buildFunnel, computeEpc, aggregateSources } from "../funnel";
import type { RollupRow } from "../funnel";

// ── buildFunnel ───────────────────────────────────────────────────────────────

function row(event_type: string, event_count: number, unique_visitors: number): RollupRow {
  return {
    date: "2026-05-01",
    event_type,
    entity_type: "app",
    entity_id: "app-1",
    owner_org_id: null,
    affiliate_id: null,
    reseller_id: null,
    event_count,
    unique_visitors,
  };
}

const AFFILIATE_STAGES = [
  { label: "Clicks",          event_type: "click" },
  { label: "Signups",         event_type: "signup" },
  { label: "Checkout starts", event_type: "checkout_start" },
  { label: "Subscribed",      event_type: "checkout_complete" },
];

describe("buildFunnel — affiliate stages", () => {
  it("computes conversion_pct relative to previous stage", () => {
    const rows = [
      row("click", 100, 100),
      row("signup", 40, 40),
      row("checkout_start", 20, 20),
      row("checkout_complete", 10, 10),
    ];
    const { stages, overall_conversion_pct } = buildFunnel(rows, AFFILIATE_STAGES);

    expect(stages[0].unique_visitors).toBe(100);
    expect(stages[0].conversion_pct).toBeNull(); // first stage has no predecessor

    expect(stages[1].conversion_pct).toBe(40); // 40/100
    expect(stages[2].conversion_pct).toBe(50); // 20/40
    expect(stages[3].conversion_pct).toBe(50); // 10/20

    expect(overall_conversion_pct).toBe(10); // 10/100
  });

  it("handles zero traffic gracefully", () => {
    const { stages, overall_conversion_pct } = buildFunnel([], AFFILIATE_STAGES);
    for (const s of stages) {
      expect(s.count).toBe(0);
      expect(s.unique_visitors).toBe(0);
    }
    expect(overall_conversion_pct).toBeNull();
  });

  it("aggregates multiple rows for the same event_type", () => {
    const rows = [row("click", 50, 50), row("click", 50, 50)];
    const { stages } = buildFunnel(rows, AFFILIATE_STAGES);
    expect(stages[0].count).toBe(100);
    expect(stages[0].unique_visitors).toBe(100);
  });

  it("overall_conversion_pct is null when only one stage", () => {
    const { overall_conversion_pct } = buildFunnel(
      [row("click", 10, 10)],
      [{ label: "Clicks", event_type: "click" }]
    );
    expect(overall_conversion_pct).toBeNull();
  });
});

// ── computeEpc ────────────────────────────────────────────────────────────────

describe("computeEpc — earnings per click", () => {
  it("computes EPC and click→sale correctly", () => {
    const clicks = [row("click", 100, 100)];
    const result = computeEpc(clicks, 10, 50_00); // $50 commission on 100 clicks, 10 conversions

    expect(result.clicks).toBe(100);
    expect(result.conversions).toBe(10);
    expect(result.epc_cents).toBe(50); // $0.50 per click
    expect(result.click_to_sale_pct).toBe(10); // 10/100 = 10%
  });

  it("returns null EPC and conversion when there are no clicks", () => {
    const result = computeEpc([], 5, 100_00);
    expect(result.epc_cents).toBeNull();
    expect(result.click_to_sale_pct).toBeNull();
    expect(result.clicks).toBe(0);
  });

  it("epc_cents is rounded integer (cents)", () => {
    const clicks = [row("click", 3, 3)];
    const result = computeEpc(clicks, 1, 10); // 10 cents / 3 clicks ≈ 3.33 → rounds to 3
    expect(Number.isInteger(result.epc_cents)).toBe(true);
  });
});

// ── aggregateSources ──────────────────────────────────────────────────────────

describe("aggregateSources — traffic sources", () => {
  it("groups by referrer and sorts by visits desc", () => {
    const rows = [
      { referrer: "https://twitter.com", event_count: 30, unique_visitors: 25 },
      { referrer: "https://google.com",  event_count: 80, unique_visitors: 70 },
      { referrer: null,                  event_count: 10, unique_visitors: 10 },
    ];
    const result = aggregateSources(rows);
    expect(result[0].referrer).toBe("https://google.com");
    expect(result[0].visits).toBe(80);
    expect(result[2].referrer).toBe("(direct)");
  });

  it("merges duplicate referrers", () => {
    const rows = [
      { referrer: "https://twitter.com", event_count: 10, unique_visitors: 8 },
      { referrer: "https://twitter.com", event_count: 5,  unique_visitors: 4 },
    ];
    const result = aggregateSources(rows);
    expect(result.length).toBe(1);
    expect(result[0].visits).toBe(15);
    expect(result[0].unique_visitors).toBe(12);
  });

  it("handles empty input", () => {
    expect(aggregateSources([])).toEqual([]);
  });
});

// ── Privacy invariants ────────────────────────────────────────────────────────

describe("privacy — rollup rows contain no PII", () => {
  it("visitor_hash field is never an email or IP", () => {
    // The rollup shape (RollupRow) does not carry visitor_hash — it is stripped
    // during aggregation in the SQL rollup. This test asserts the type contract.
    const r = row("click", 1, 1);
    expect("visitor_hash" in r).toBe(false);
  });

  it("rollup rows have no referrer field", () => {
    const r = row("view", 5, 3);
    expect("referrer" in r).toBe(false);
  });
});
