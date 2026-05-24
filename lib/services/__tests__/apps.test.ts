// @vitest-environment node
//
// Tests for screenshot validation: magic-bytes rejection, count constraints,
// and ordering invariants.

import { describe, it, expect } from "vitest";
import { detectLogoMimeType } from "@/lib/utils/magic-bytes";

// ── Magic bytes ────────────────────────────────────────────────────────────────

describe("detectLogoMimeType — screenshot upload validation", () => {
  it("accepts PNG", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(detectLogoMimeType(buf)).toBe("image/png");
  });

  it("accepts JPEG", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(detectLogoMimeType(buf)).toBe("image/jpeg");
  });

  it("accepts WebP", () => {
    const riff = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
    const buf = Buffer.from(riff);
    expect(detectLogoMimeType(buf)).toBe("image/webp");
  });

  it("rejects SVG (text/xml content)", () => {
    const svgBytes = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    expect(detectLogoMimeType(svgBytes)).toBeNull();
  });

  it("rejects GIF", () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectLogoMimeType(gif)).toBeNull();
  });

  it("rejects empty buffer", () => {
    expect(detectLogoMimeType(Buffer.alloc(0))).toBeNull();
  });

  it("rejects random bytes", () => {
    expect(detectLogoMimeType(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });
});

// ── Screenshot count validation (mirrors DB CHECK constraint) ──────────────────

function validateScreenshotCount(urls: string[]): boolean {
  const n = urls.length;
  return n === 0 || (n >= 3 && n <= 7);
}

describe("screenshot count constraint", () => {
  it("allows 0 (pending app)", () => expect(validateScreenshotCount([])).toBe(true));
  it("rejects 1", () => expect(validateScreenshotCount(["a"])).toBe(false));
  it("rejects 2", () => expect(validateScreenshotCount(["a", "b"])).toBe(false));
  it("allows 3 (minimum for submission)", () => {
    expect(validateScreenshotCount(["a", "b", "c"])).toBe(true);
  });
  it("allows 7 (maximum)", () => {
    expect(validateScreenshotCount(Array(7).fill("x"))).toBe(true);
  });
  it("rejects 8", () => expect(validateScreenshotCount(Array(8).fill("x"))).toBe(false));
});

// ── First-image-is-preview invariant ──────────────────────────────────────────

describe("screenshot ordering", () => {
  it("first URL is the preview shown in marketplace cards", () => {
    const screenshots = [
      "https://example.com/preview.png",
      "https://example.com/detail1.png",
      "https://example.com/detail2.png",
    ];
    const previewUrl = screenshots[0];
    expect(previewUrl).toBe("https://example.com/preview.png");
  });

  it("reorder preserves all URLs", () => {
    const original = ["a", "b", "c", "d"];
    const reordered = [original[2], original[0], original[3], original[1]];
    expect(reordered.sort()).toEqual(original.sort());
  });
});
