/**
 * Loop and no-progress guards for the agent step.
 *
 * checkIterationCap  — enforces max_iterations (per-step) and global platform cap.
 * detectNoProgress   — aborts if the same tool call with identical args repeats
 *                      NO_PROGRESS_REPEAT_LIMIT times (agent is spinning).
 * hashArgs           — stable JSON hash for no-progress comparison.
 */

const NO_PROGRESS_REPEAT_LIMIT = 3;

export interface ToolCallRecord {
  tool: string;
  argsHash: string;
}

export interface IterationCapResult {
  exceeded: boolean;
  reason?: string;
}

/**
 * Returns exceeded=true if iteration >= max_iterations or global cap.
 * `iteration` is 0-based (first call = iteration 0).
 */
export function checkIterationCap(
  iteration: number,
  maxIterations: number,
  globalCap: number
): IterationCapResult {
  if (iteration >= globalCap) {
    return { exceeded: true, reason: `global iteration cap reached (${globalCap})` };
  }
  if (iteration >= maxIterations) {
    return { exceeded: true, reason: `step max_iterations reached (${maxIterations})` };
  }
  return { exceeded: false };
}

/**
 * Returns true if the (tool, argsHash) pair has appeared NO_PROGRESS_REPEAT_LIMIT
 * or more times in the history — the agent is looping without progress.
 */
export function detectNoProgress(
  history: ToolCallRecord[],
  currentTool: string,
  currentArgsHash: string
): boolean {
  const repeats = history.filter(
    (h) => h.tool === currentTool && h.argsHash === currentArgsHash
  ).length;
  return repeats >= NO_PROGRESS_REPEAT_LIMIT;
}

/** Stable, deterministic hash of tool arguments for no-progress detection. */
export function hashArgs(args: unknown): string {
  try {
    const sorted = sortKeys(args);
    return JSON.stringify(sorted);
  } catch {
    return String(args);
  }
}

function sortKeys(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortKeys);
  if (val !== null && typeof val === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val as object).sort()) {
      sorted[k] = sortKeys((val as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return val;
}
