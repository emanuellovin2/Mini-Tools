import { describe, it, expect } from "vitest";
import {
  stripeStatusToSubscriptionStatus,
  subscriptionStatusToAccess,
  isAccessActive,
} from "../entitlements";

describe("stripeStatusToSubscriptionStatus", () => {
  const validStatuses = [
    "incomplete", "incomplete_expired", "active", "trialing",
    "past_due", "unpaid", "canceled", "paused",
  ];

  it.each(validStatuses)("accepts valid status: %s", (status) => {
    expect(stripeStatusToSubscriptionStatus(status)).toBe(status);
  });

  it("throws on unknown status", () => {
    expect(() => stripeStatusToSubscriptionStatus("unknown")).toThrow(
      'Unknown Stripe subscription status: "unknown"'
    );
  });

  it("throws on empty string", () => {
    expect(() => stripeStatusToSubscriptionStatus("")).toThrow();
  });
});

describe("subscriptionStatusToAccess — SPEC §8 state machine", () => {
  it.each([
    ["active", true],
    ["trialing", true],
    ["incomplete", false],
    ["incomplete_expired", false],
    ["past_due", false],
    ["unpaid", false],
    ["paused", false],
    ["canceled", false],
  ] as const)("status=%s → access=%s", (status, expected) => {
    expect(subscriptionStatusToAccess(status)).toBe(expected);
  });

  it("past_due is false (suspended, not active) — SPEC §8", () => {
    expect(subscriptionStatusToAccess("past_due")).toBe(false);
  });

  it("cancel_at_period_end: active subscription still returns true until period ends", () => {
    // cancel_at_period_end=true keeps status='active' until period end
    // The webhook keeps status=active in this state — so access remains true
    expect(subscriptionStatusToAccess("active")).toBe(true);
  });
});

describe("isAccessActive — pause_collection check (#23)", () => {
  const future = new Date(Date.now() + 30 * 86400_000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();

  it("returns false when paused_until is in the future (even if status=active)", () => {
    expect(isAccessActive({ status: "active", paused_until: future })).toBe(false);
  });

  it("returns true when paused_until is in the past (pause expired)", () => {
    expect(isAccessActive({ status: "active", paused_until: past })).toBe(true);
  });

  it("returns true when paused_until is null and status=active", () => {
    expect(isAccessActive({ status: "active", paused_until: null })).toBe(true);
  });

  it("returns false when paused_until is null and status=canceled", () => {
    expect(isAccessActive({ status: "canceled", paused_until: null })).toBe(false);
  });

  it("returns false when paused_until is null and status=past_due", () => {
    expect(isAccessActive({ status: "past_due", paused_until: null })).toBe(false);
  });

  it("paused_until takes priority — false even if trialing", () => {
    expect(isAccessActive({ status: "trialing", paused_until: future })).toBe(false);
  });
});
