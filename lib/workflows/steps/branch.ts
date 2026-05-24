/**
 * Branch step — evaluates a condition to choose the next step.
 *
 * Safety: condition evaluation uses only comparison operators against
 * object-path lookups. NO eval, NO Function constructor.
 *
 * Config:
 *   {
 *     branches: [
 *       { condition: "trigger.score > 80", next_step_key: "high_value" },
 *       { condition: "trigger.score >= 50", next_step_key: "mid_value" },
 *     ],
 *     default_next_step_key: "low_value"  // taken when no branch matches
 *   }
 *
 * Condition grammar: `{path} {op} {literal}`
 *   Supported ops: == != > >= < <= contains not_contains
 *   Path: dot-notation into context (same as transform step)
 *   Literal: "string" (quoted), number, true, false, null
 */

import { getPath } from "./transform";

export interface BranchConfig {
  branches: Array<{
    condition: string;
    next_step_key: string;
  }>;
  default_next_step_key: string | null;
}

export interface BranchInput {
  context: Record<string, unknown>;
}

export interface BranchOutput {
  matched_branch: string | null;
  next_step_key: string | null;
}

type Op = "==" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "not_contains";
const OP_RE = /^([\w.]+)\s*(==|!=|>=|<=|>|<|contains|not_contains)\s*(.+)$/;

function parseLiteral(raw: string): unknown {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  const n = Number(s);
  if (!Number.isNaN(n)) return n;
  return s;
}

/** Evaluate a single condition string against the run context. */
export function evaluateCondition(
  condition: string,
  context: Record<string, unknown>
): boolean {
  const match = condition.trim().match(OP_RE);
  if (!match) {
    throw new Error(`branch: cannot parse condition: "${condition}"`);
  }
  const [, path, rawOp, rawLiteral] = match;
  const lhs = getPath(context, path);
  const rhs = parseLiteral(rawLiteral);
  const op = rawOp as Op;

  switch (op) {
    case "==": return lhs == rhs; // intentional loose equality for convenience
    case "!=": return lhs != rhs;
    case ">":  return Number(lhs) > Number(rhs);
    case ">=": return Number(lhs) >= Number(rhs);
    case "<":  return Number(lhs) < Number(rhs);
    case "<=": return Number(lhs) <= Number(rhs);
    case "contains":     return String(lhs ?? "").includes(String(rhs));
    case "not_contains": return !String(lhs ?? "").includes(String(rhs));
  }
}

export async function runBranchStep(
  config: BranchConfig,
  input: BranchInput
): Promise<BranchOutput> {
  if (!Array.isArray(config.branches)) {
    throw new Error("branch: config.branches must be an array");
  }

  for (const branch of config.branches) {
    if (!branch.condition || !branch.next_step_key) {
      throw new Error("branch: each branch must have condition and next_step_key");
    }
    if (evaluateCondition(branch.condition, input.context)) {
      return { matched_branch: branch.condition, next_step_key: branch.next_step_key };
    }
  }

  return {
    matched_branch: null,
    next_step_key: config.default_next_step_key ?? null,
  };
}
