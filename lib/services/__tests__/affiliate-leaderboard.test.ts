// @vitest-environment node
//
// Tests for #25 affiliate leaderboard + badges + public profiles.
// Pure unit tests run without a DB. Integration tests require local Supabase.

import { describe, it, expect } from "vitest";
import { computeEarnedBadgeIds, type AffiliateBadge } from "@/lib/services/affiliate";

// ── Static badge definitions (mirror the migration INSERT) ────────────────────

const BADGES: AffiliateBadge[] = [
  { id: "rookie",   display_name: "Rookie",   description: "", threshold_kind: "lifetime_mrr", threshold_value: 10_000,    icon_emoji: "🌱", sort_order: 10 },
  { id: "silver",   display_name: "Silver",   description: "", threshold_kind: "lifetime_mrr", threshold_value: 100_000,   icon_emoji: "🥈", sort_order: 20 },
  { id: "gold",     display_name: "Gold",     description: "", threshold_kind: "lifetime_mrr", threshold_value: 500_000,   icon_emoji: "🥇", sort_order: 30 },
  { id: "platinum", display_name: "Platinum", description: "", threshold_kind: "lifetime_mrr", threshold_value: 2_000_000, icon_emoji: "💎", sort_order: 40 },
  { id: "hot",      display_name: "On Fire",  description: "", threshold_kind: "active_mrr",   threshold_value: 100_000,   icon_emoji: "🔥", sort_order: 50 },
  { id: "veteran",  display_name: "Veteran",  description: "", threshold_kind: "tenure_days",  threshold_value: 365,       icon_emoji: "🏛️", sort_order: 60 },
];

function makeProfile(overrides: Partial<{
  affiliate_lifetime_mrr_cents: number;
  affiliate_active_mrr_cents: number;
  created_at: string;
}>) {
  return {
    affiliate_lifetime_mrr_cents: 0,
    affiliate_active_mrr_cents: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Badge derivation ─────────────────────────────────────────────────────────

describe("computeEarnedBadgeIds — badge derivation", () => {
  it("earns no badges with zero stats", () => {
    expect(computeEarnedBadgeIds(makeProfile({}), BADGES)).toEqual([]);
  });

  it("earns Rookie at exactly $100 lifetime MRR (10_000 cents)", () => {
    const ids = computeEarnedBadgeIds(makeProfile({ affiliate_lifetime_mrr_cents: 10_000 }), BADGES);
    expect(ids).toContain("rookie");
    expect(ids).not.toContain("silver");
  });

  it("earns Rookie + Silver at $1.5k lifetime, not Gold", () => {
    const ids = computeEarnedBadgeIds(makeProfile({ affiliate_lifetime_mrr_cents: 150_000 }), BADGES);
    expect(ids).toContain("rookie");
    expect(ids).toContain("silver");
    expect(ids).not.toContain("gold");
  });

  it("earns Rookie + Silver + Gold at exactly $5k lifetime", () => {
    const ids = computeEarnedBadgeIds(makeProfile({ affiliate_lifetime_mrr_cents: 500_000 }), BADGES);
    expect(ids).toContain("rookie");
    expect(ids).toContain("silver");
    expect(ids).toContain("gold");
    expect(ids).not.toContain("platinum");
  });

  it("earns all lifetime badges at $20k+ lifetime", () => {
    const ids = computeEarnedBadgeIds(makeProfile({ affiliate_lifetime_mrr_cents: 2_000_001 }), BADGES);
    expect(ids).toContain("rookie");
    expect(ids).toContain("silver");
    expect(ids).toContain("gold");
    expect(ids).toContain("platinum");
  });

  it("earns On Fire at $1k active MRR, independent of lifetime", () => {
    const ids = computeEarnedBadgeIds(
      makeProfile({ affiliate_active_mrr_cents: 100_000, affiliate_lifetime_mrr_cents: 0 }),
      BADGES
    );
    expect(ids).toContain("hot");
    expect(ids).not.toContain("rookie");
  });

  it("does not earn On Fire below $1k active MRR", () => {
    const ids = computeEarnedBadgeIds(
      makeProfile({ affiliate_active_mrr_cents: 99_999 }),
      BADGES
    );
    expect(ids).not.toContain("hot");
  });

  it("does not earn Veteran for brand-new affiliate", () => {
    const ids = computeEarnedBadgeIds(
      makeProfile({ created_at: new Date().toISOString() }),
      BADGES
    );
    expect(ids).not.toContain("veteran");
  });

  it("earns Veteran for affiliate created 366 days ago", () => {
    const oldDate = new Date(Date.now() - 366 * 86_400_000).toISOString();
    const ids = computeEarnedBadgeIds(makeProfile({ created_at: oldDate }), BADGES);
    expect(ids).toContain("veteran");
  });

  it("does not earn Veteran at 364 days", () => {
    const notYet = new Date(Date.now() - 364 * 86_400_000).toISOString();
    const ids = computeEarnedBadgeIds(makeProfile({ created_at: notYet }), BADGES);
    expect(ids).not.toContain("veteran");
  });

  it("threshold is inclusive: exactly $5k lifetime earns Gold", () => {
    const ids = computeEarnedBadgeIds(
      makeProfile({ affiliate_lifetime_mrr_cents: 500_000 }),
      BADGES
    );
    expect(ids).toContain("gold");
  });

  it("one cent below $5k does NOT earn Gold", () => {
    const ids = computeEarnedBadgeIds(
      makeProfile({ affiliate_lifetime_mrr_cents: 499_999 }),
      BADGES
    );
    expect(ids).not.toContain("gold");
  });
});

// ── MRR rounding helper (inlined for test clarity) ────────────────────────────

function roundMrr(cents: number): string {
  if (cents <= 0) return "$0";
  const dollars = cents / 100;
  if (dollars < 100) return "<$100";
  const rounded = Math.round(dollars / 100) * 100;
  if (rounded >= 1_000) return `$${(rounded / 1_000).toFixed(rounded % 1_000 === 0 ? 0 : 1)}k`;
  return `$${rounded}`;
}

describe("roundMrr — public display rounding", () => {
  it("$0 → '$0'", () => expect(roundMrr(0)).toBe("$0"));
  it("$50 (5_000 cents) → '<$100' (sub-$100 band)", () => expect(roundMrr(5_000)).toBe("<$100"));
  it("$99 (9_900 cents) → '<$100'", () => expect(roundMrr(9_900)).toBe("<$100"));
  it("$100 (10_000 cents) → '$100'", () => expect(roundMrr(10_000)).toBe("$100"));
  it("$1234 rounds to '$1.2k'", () => expect(roundMrr(123_400)).toBe("$1.2k"));
  it("$5000 → '$5k'", () => expect(roundMrr(500_000)).toBe("$5k"));
  it("$4387 rounds to '$4.4k'", () => expect(roundMrr(438_700)).toBe("$4.4k"));
});

// ── Leaderboard rank ordering ─────────────────────────────────────────────────

describe("leaderboard rank ordering invariant", () => {
  type FakeRow = { affiliate_active_mrr_cents: number; active_rank: number };

  // Simulate what the DB view RANK() would produce
  function fakeRanks(mrrs: number[]): FakeRow[] {
    const sorted = [...mrrs].sort((a, b) => b - a);
    let rank = 0;
    let prevMrr = -1;
    return sorted.map((mrr, i) => {
      if (mrr !== prevMrr) rank = i + 1;
      prevMrr = mrr;
      return { affiliate_active_mrr_cents: mrr, active_rank: rank };
    });
  }

  it("higher MRR gets a lower (better) rank number", () => {
    const rows = fakeRanks([300_000, 500_000, 100_000]);
    const sorted = rows.sort((a, b) => a.active_rank - b.active_rank);
    expect(sorted[0].affiliate_active_mrr_cents).toBe(500_000);
    expect(sorted[0].active_rank).toBe(1);
    expect(sorted[1].active_rank).toBe(2);
    expect(sorted[2].active_rank).toBe(3);
  });

  it("tied MRR gets the same rank (RANK, not ROW_NUMBER)", () => {
    const rows = fakeRanks([200_000, 200_000, 100_000]);
    const rank200 = rows.filter((r) => r.affiliate_active_mrr_cents === 200_000);
    expect(rank200.every((r) => r.active_rank === 1)).toBe(true);
    const rank100 = rows.find((r) => r.affiliate_active_mrr_cents === 100_000);
    expect(rank100?.active_rank).toBe(3);
  });
});
