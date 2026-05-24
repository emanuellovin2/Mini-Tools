/**
 * Delay step — schedules the run to resume after a specified duration.
 *
 * This step does NOT block a serverless function. It simply returns a
 * `nextRunAt` timestamp. The executor stores this in workflow_runs.next_run_at
 * and exits; the cron tick will re-claim the run once the time arrives.
 *
 * Config:
 *   { "duration_seconds": 3600 }     // wait 1 hour
 *   { "until_iso": "2026-06-01T00:00:00Z" }  // wait until a specific time
 *
 * Zero compute cost while waiting — the run stays in `running` state with
 * next_run_at set to the future; no long-running invocation is needed.
 */

export interface DelayConfig {
  /** Seconds to wait from now. */
  duration_seconds?: number;
  /** ISO 8601 datetime to wait until. Takes precedence over duration_seconds. */
  until_iso?: string;
}

export interface DelayOutput {
  /** ISO timestamp when the run should resume. */
  next_run_at: string;
  waited_seconds: number;
}

const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60; // 30 days cap

export async function runDelayStep(config: DelayConfig): Promise<{
  output: DelayOutput;
  nextRunAt: Date;
}> {
  const now = Date.now();
  let targetMs: number;

  if (config.until_iso) {
    const target = new Date(config.until_iso);
    if (Number.isNaN(target.getTime())) {
      throw new Error(`delay: until_iso is not a valid ISO date: "${config.until_iso}"`);
    }
    targetMs = Math.max(target.getTime(), now);
  } else if (typeof config.duration_seconds === "number") {
    if (config.duration_seconds < 0) {
      throw new Error("delay: duration_seconds must be non-negative");
    }
    const cappedSeconds = Math.min(config.duration_seconds, MAX_DELAY_SECONDS);
    targetMs = now + cappedSeconds * 1000;
  } else {
    throw new Error("delay: config must specify duration_seconds or until_iso");
  }

  const nextRunAt = new Date(targetMs);
  const waited_seconds = Math.round((targetMs - now) / 1000);

  return {
    output: { next_run_at: nextRunAt.toISOString(), waited_seconds },
    nextRunAt,
  };
}
