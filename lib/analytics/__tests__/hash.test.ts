import { describe, it, expect, vi } from "vitest";
import { isBot, isDnt, visitorHash } from "../hash";

// ── isBot ─────────────────────────────────────────────────────────────────────

describe("isBot", () => {
  it("detects Googlebot", () => {
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
  });
  it("detects headless Chrome", () => {
    expect(isBot("HeadlessChrome/120.0")).toBe(true);
  });
  it("detects curl", () => {
    expect(isBot("curl/8.1.2")).toBe(true);
  });
  it("passes a real browser UA", () => {
    expect(isBot("Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/124")).toBe(false);
  });
});

// ── isDnt ─────────────────────────────────────────────────────────────────────

describe("isDnt", () => {
  it("returns true for DNT: 1", () => {
    const h = new Headers({ dnt: "1" });
    expect(isDnt(h)).toBe(true);
  });
  it("returns true for Sec-GPC: 1", () => {
    const h = new Headers({ "sec-gpc": "1" });
    expect(isDnt(h)).toBe(true);
  });
  it("returns false when absent", () => {
    expect(isDnt(new Headers())).toBe(false);
  });
  it("returns false for DNT: 0", () => {
    const h = new Headers({ dnt: "0" });
    expect(isDnt(h)).toBe(false);
  });
});

// ── visitorHash ───────────────────────────────────────────────────────────────

describe("visitorHash", () => {
  it("returns null when DNT is set", async () => {
    const h = new Headers({ dnt: "1" });
    const result = await visitorHash("1.2.3.4", "Mozilla/5.0", h);
    expect(result).toBeNull();
  });

  it("returns a 16-hex-char string when no DNT", async () => {
    const h = new Headers();
    const result = await visitorHash("1.2.3.4", "Mozilla/5.0", h);
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces the same hash for the same input within a day", async () => {
    const h = new Headers();
    const a = await visitorHash("1.2.3.4", "ua", h);
    const b = await visitorHash("1.2.3.4", "ua", h);
    expect(a).toBe(b);
  });

  it("produces different hashes for different IPs", async () => {
    const h = new Headers();
    const a = await visitorHash("1.2.3.4", "ua", h);
    const b = await visitorHash("9.9.9.9", "ua", h);
    expect(a).not.toBe(b);
  });

  it("hash length is exactly 16 characters (not raw IP, not full fingerprint)", async () => {
    const h = new Headers();
    const result = await visitorHash("203.0.113.1", "SomeBrowser/1.0", h);
    // The full HMAC-SHA256 is 64 hex chars; we truncate to 16 to reduce re-ID risk.
    expect(result?.length).toBe(16);
    // Must not contain the raw IP
    expect(result).not.toContain("203");
  });
});
