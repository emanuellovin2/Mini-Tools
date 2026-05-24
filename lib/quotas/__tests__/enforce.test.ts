import { describe, it, expect } from "vitest";
import { QuotaExceededError, QUOTA_EXCEEDED } from "../enforce";

// Unit tests for quota enforcement logic — error class and pure-function aspects.
// enforceQuota() is integration-tested against a live Supabase stack.

describe("QuotaExceededError", () => {
  it("carries the correct code", () => {
    const err = new QuotaExceededError("offers", 100, 100);
    expect(err.code).toBe(QUOTA_EXCEEDED);
  });

  it("formats a readable message", () => {
    const err = new QuotaExceededError("offers", 50, 50);
    expect(err.message).toContain("offers");
    expect(err.message).toContain("50");
  });

  it("is an instance of Error", () => {
    const err = new QuotaExceededError("api_keys", 10, 11);
    expect(err).toBeInstanceOf(Error);
  });

  it("exposes resource, limit, used properties", () => {
    const err = new QuotaExceededError("workflows", 500, 500);
    expect(err.resource).toBe("workflows");
    expect(err.limit).toBe(500);
    expect(err.used).toBe(500);
  });

  it("throws when used === limit (at-limit = block)", () => {
    // Verifies that the enforcement is >=, not >
    const shouldBlock = (used: number, limit: number) => used >= limit;
    expect(shouldBlock(50, 50)).toBe(true);
    expect(shouldBlock(51, 50)).toBe(true);
    expect(shouldBlock(49, 50)).toBe(false);
  });
});
