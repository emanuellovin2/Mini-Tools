export interface TierResult {
  tier: 1 | 2 | 3 | 4;
  cut_bps: number;
}

// Computes the platform's tier and cut for a vendor based on their trailing
// calendar-month gross revenue (SPEC §3). Negative gross is floored at 0.
// Boundaries: lower-inclusive, upper-exclusive.
export function computeTier(grossCents: number): TierResult {
  const gross = Math.max(0, grossCents);
  if (gross >= 1_000_000) return { tier: 4, cut_bps: 300 };   // $10k+
  if (gross >= 300_000)   return { tier: 3, cut_bps: 500 };   // $3k–$10k
  if (gross >= 100_000)   return { tier: 2, cut_bps: 800 };   // $1k–$3k
  return { tier: 1, cut_bps: 1_200 };                          // $0–$1k
}
