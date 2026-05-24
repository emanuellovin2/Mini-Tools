// @vitest-environment node
//
// Tests for the delay step — verifies that it returns a future nextRunAt
// without blocking and respects the max-delay cap.

import { describe, it, expect } from "vitest";
import { runDelayStep } from "../steps/delay";

describe("runDelayStep", () => {
  it("schedules next_run_at in the future by duration_seconds", async () => {
    const before = Date.now();
    const { output, nextRunAt } = await runDelayStep({ duration_seconds: 3600 });
    const after = Date.now();

    expect(nextRunAt.getTime()).toBeGreaterThan(before + 3599_000);
    expect(nextRunAt.getTime()).toBeLessThan(after + 3601_000);
    expect(output.waited_seconds).toBe(3600);
  });

  it("uses until_iso when both are provided", async () => {
    const target = new Date(Date.now() + 60_000).toISOString();
    const { nextRunAt } = await runDelayStep({ until_iso: target, duration_seconds: 3600 });
    // until_iso takes precedence — should be ~60s from now, not 3600s
    expect(Math.abs(nextRunAt.getTime() - new Date(target).getTime())).toBeLessThan(100);
  });

  it("caps at 30 days", async () => {
    const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60;
    const { output } = await runDelayStep({ duration_seconds: THIRTY_ONE_DAYS });
    expect(output.waited_seconds).toBe(30 * 24 * 60 * 60);
  });

  it("rejects negative duration", async () => {
    await expect(runDelayStep({ duration_seconds: -1 })).rejects.toThrow("non-negative");
  });

  it("rejects missing config", async () => {
    await expect(runDelayStep({})).rejects.toThrow();
  });

  it("rejects invalid until_iso", async () => {
    await expect(runDelayStep({ until_iso: "not-a-date" })).rejects.toThrow("valid ISO");
  });

  it("returns a Date object for nextRunAt", async () => {
    const { nextRunAt } = await runDelayStep({ duration_seconds: 10 });
    expect(nextRunAt).toBeInstanceOf(Date);
  });
});
