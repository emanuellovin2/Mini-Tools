import { describe, it, expect } from "vitest";
import { computeTier } from "../billing";

describe("computeTier — SPEC §3 tier boundaries (4-tier, #15)", () => {
  // Tier 1: gross < $1,000
  it("$0 gross → Tier 1, 1200 bps", () => {
    expect(computeTier(0)).toEqual({ tier: 1, cut_bps: 1_200 });
  });

  it("$999.99 (99_999 cents) → Tier 1", () => {
    expect(computeTier(99_999)).toEqual({ tier: 1, cut_bps: 1_200 });
  });

  // Tier 2: $1,000 ≤ gross < $3,000
  it("$1000.00 (100_000 cents) → Tier 2, 800 bps", () => {
    expect(computeTier(100_000)).toEqual({ tier: 2, cut_bps: 800 });
  });

  it("$1000.01 (100_001 cents) → Tier 2", () => {
    expect(computeTier(100_001)).toEqual({ tier: 2, cut_bps: 800 });
  });

  it("$2999.99 (299_999 cents) → Tier 2", () => {
    expect(computeTier(299_999)).toEqual({ tier: 2, cut_bps: 800 });
  });

  // Tier 3: $3,000 ≤ gross < $10,000
  it("$3000.00 (300_000 cents) → Tier 3, 500 bps", () => {
    expect(computeTier(300_000)).toEqual({ tier: 3, cut_bps: 500 });
  });

  it("$3000.01 (300_001 cents) → Tier 3", () => {
    expect(computeTier(300_001)).toEqual({ tier: 3, cut_bps: 500 });
  });

  it("$9999.99 (999_999 cents) → Tier 3", () => {
    expect(computeTier(999_999)).toEqual({ tier: 3, cut_bps: 500 });
  });

  // Tier 4: gross ≥ $10,000
  it("$10000.00 (1_000_000 cents) → Tier 4, 300 bps", () => {
    expect(computeTier(1_000_000)).toEqual({ tier: 4, cut_bps: 300 });
  });

  it("$50000 (5_000_000 cents) → Tier 4", () => {
    expect(computeTier(5_000_000)).toEqual({ tier: 4, cut_bps: 300 });
  });

  // Negative gross floored at 0
  it("negative gross → Tier 1, no crash", () => {
    expect(computeTier(-50_000)).toEqual({ tier: 1, cut_bps: 1_200 });
  });

  it("large negative gross → Tier 1, no crash", () => {
    expect(computeTier(-999_999)).toEqual({ tier: 1, cut_bps: 1_200 });
  });
});
