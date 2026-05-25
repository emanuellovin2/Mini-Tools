// Pure function — no I/O, no side effects. Mirrors the SQL logic in
// refresh_client_health_scores so the UI can preview scores client-side.

export type ChurnRisk = "low" | "medium" | "high";

export interface ChurnRiskInput {
  activeDeployments: number;
  failedDeployments: number;
  orphanedDeployments: number;
  metricEvents7d: number;
  daysSinceActivity: number | null;
  daysSinceAccepted: number | null;
  creditsRemainingCents: number;
}

export interface ChurnRiskResult {
  score: number; // 0–100
  risk: ChurnRisk;
}

export function computeChurnRisk(input: ChurnRiskInput): ChurnRiskResult {
  const {
    activeDeployments,
    failedDeployments,
    orphanedDeployments,
    metricEvents7d,
    daysSinceActivity,
    daysSinceAccepted,
    creditsRemainingCents,
  } = input;

  let score = 100;
  if (activeDeployments === 0) score -= 30;
  if (failedDeployments > 0) score -= 20;
  if (metricEvents7d === 0 && (daysSinceAccepted ?? 0) > 14) score -= 15;
  if (creditsRemainingCents < 1_000) score -= 10;
  if (daysSinceActivity !== null && daysSinceActivity > 3) score -= 10;
  if (orphanedDeployments > 0) score -= 15;
  score = Math.max(score, 0);

  let risk: ChurnRisk;
  if (
    (activeDeployments === 0 && (daysSinceAccepted ?? 0) > 7) ||
    (failedDeployments > 0 && (daysSinceActivity ?? 0) >= 7) ||
    (metricEvents7d === 0 && (daysSinceAccepted ?? 0) > 14)
  ) {
    risk = "high";
  } else if (
    (daysSinceActivity ?? 0) > 3 ||
    creditsRemainingCents < 1_000 ||
    failedDeployments > 0
  ) {
    risk = "medium";
  } else {
    risk = "low";
  }

  return { score, risk };
}
