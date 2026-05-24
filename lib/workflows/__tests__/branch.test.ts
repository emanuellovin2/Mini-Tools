// @vitest-environment node
//
// Tests for the branch step — condition evaluator safety and correctness.

import { describe, it, expect } from "vitest";
import { evaluateCondition, runBranchStep } from "../steps/branch";

const ctx = {
  trigger: { score: 85, status: "won", label: "PRIORITY customer" },
  step1: { count: 0 },
};

describe("evaluateCondition", () => {
  it("evaluates == for number", () => {
    expect(evaluateCondition("step1.count == 0", ctx)).toBe(true);
    expect(evaluateCondition("step1.count == 1", ctx)).toBe(false);
  });

  it("evaluates != ", () => {
    expect(evaluateCondition("trigger.status != 'lost'", ctx)).toBe(true);
    expect(evaluateCondition("trigger.status != 'won'", ctx)).toBe(false);
  });

  it("evaluates > and >=", () => {
    expect(evaluateCondition("trigger.score > 80", ctx)).toBe(true);
    expect(evaluateCondition("trigger.score >= 85", ctx)).toBe(true);
    expect(evaluateCondition("trigger.score > 85", ctx)).toBe(false);
  });

  it("evaluates < and <=", () => {
    expect(evaluateCondition("trigger.score < 100", ctx)).toBe(true);
    expect(evaluateCondition("trigger.score <= 85", ctx)).toBe(true);
    expect(evaluateCondition("trigger.score < 85", ctx)).toBe(false);
  });

  it("evaluates contains", () => {
    expect(evaluateCondition("trigger.label contains 'PRIORITY'", ctx)).toBe(true);
    expect(evaluateCondition("trigger.label contains 'SPAM'", ctx)).toBe(false);
  });

  it("evaluates not_contains", () => {
    expect(evaluateCondition("trigger.label not_contains 'SPAM'", ctx)).toBe(true);
  });

  it("string equality with double quotes", () => {
    expect(evaluateCondition('trigger.status == "won"', ctx)).toBe(true);
  });

  it("throws on unparseable condition", () => {
    expect(() => evaluateCondition("garbage", ctx)).toThrow();
  });

  it("does NOT execute code in condition (eval safety)", () => {
    // Malformed condition that looks like a function call — must throw or return false, not execute
    expect(() => evaluateCondition("trigger.score > process.exit(1)", ctx)).not.toThrow();
  });
});

describe("runBranchStep", () => {
  it("returns the first matching branch", async () => {
    const cfg = {
      branches: [
        { condition: "trigger.score >= 90", next_step_key: "high" },
        { condition: "trigger.score >= 70", next_step_key: "medium" },
      ],
      default_next_step_key: "low",
    };
    const result = await runBranchStep(cfg, { context: ctx });
    expect(result.next_step_key).toBe("medium");
  });

  it("falls through to default when no branch matches", async () => {
    const cfg = {
      branches: [
        { condition: "trigger.score >= 99", next_step_key: "top" },
      ],
      default_next_step_key: "fallback",
    };
    const result = await runBranchStep(cfg, { context: ctx });
    expect(result.next_step_key).toBe("fallback");
    expect(result.matched_branch).toBeNull();
  });

  it("returns null next_step_key when no match and no default", async () => {
    const cfg = {
      branches: [{ condition: "trigger.score >= 99", next_step_key: "top" }],
      default_next_step_key: null,
    };
    const result = await runBranchStep(cfg, { context: ctx });
    expect(result.next_step_key).toBeNull();
  });
});
