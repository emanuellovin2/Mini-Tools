/**
 * Budget guards for the agent step.
 *
 * All cost caps are enforced BEFORE each LLM call:
 *   - Per-step budget_cents (from AgentStepConfig)
 *   - Platform-wide AGENT_MAX_RUN_BUDGET_CENTS hard ceiling
 *
 * estimateCents — rough token-to-cost estimate before the call.
 * checkBudget   — returns allowed/reason; caller must abort if !allowed.
 */

const CENTS_PER_1K_TOKENS_DEFAULT = 0.3; // ~$0.003/1k tokens (conservative default)

/**
 * Rough pre-call cost estimate in cents.
 * Callers use this to gate reserve_credits before the provider call.
 */
export function estimateCents(model: string, maxTokens: number): number {
  // Model-specific rates can be extended here without changing callers.
  let ratePerKToken = CENTS_PER_1K_TOKENS_DEFAULT;
  if (model.includes("gpt-4o") || model.includes("claude-3-5")) ratePerKToken = 1.5;
  else if (model.includes("gpt-4") || model.includes("claude-3-opus")) ratePerKToken = 3.0;
  else if (model.includes("gpt-3.5") || model.includes("claude-haiku")) ratePerKToken = 0.05;
  return Math.max(1, Math.ceil((maxTokens / 1000) * ratePerKToken));
}

export interface BudgetCheckArgs {
  spentCents: number;
  stepBudgetCents: number;
  estimatedCents: number;
  /** AGENT_MAX_RUN_BUDGET_CENTS env var — hard platform ceiling */
  maxRunBudgetCents: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkBudget(args: BudgetCheckArgs): BudgetCheckResult {
  if (args.spentCents + args.estimatedCents > args.maxRunBudgetCents) {
    return {
      allowed: false,
      reason: `platform run budget exceeded: spent ${args.spentCents}¢ + ~${args.estimatedCents}¢ > max ${args.maxRunBudgetCents}¢`,
    };
  }
  if (args.spentCents + args.estimatedCents > args.stepBudgetCents) {
    return {
      allowed: false,
      reason: `step budget exceeded: spent ${args.spentCents}¢ + ~${args.estimatedCents}¢ > step max ${args.stepBudgetCents}¢`,
    };
  }
  return { allowed: true };
}
