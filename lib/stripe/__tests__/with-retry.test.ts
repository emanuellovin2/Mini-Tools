import { describe, it, expect, vi } from "vitest";
import { withStripeRetry } from "../with-retry";

describe("withStripeRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withStripeRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and eventually succeeds", async () => {
    const err429 = Object.assign(new Error("rate limited"), { statusCode: 429 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err429)
      .mockRejectedValueOnce(err429)
      .mockResolvedValue("ok after retry");

    // Shorten delays in test
    vi.useFakeTimers();
    const promise = withStripeRetry(fn);
    // Advance through all potential delays
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBe("ok after retry");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on Stripe 500", async () => {
    const err500 = Object.assign(new Error("server error"), { statusCode: 500 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err500)
      .mockResolvedValue("recovered");

    vi.useFakeTimers();
    const promise = withStripeRetry(fn);
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 400 (non-retryable)", async () => {
    const err400 = Object.assign(new Error("bad request"), { statusCode: 400 });
    const fn = vi.fn().mockRejectedValue(err400);
    await expect(withStripeRetry(fn)).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after 5 failed attempts (max)", async () => {
    const err = Object.assign(new Error("persistent 429"), { statusCode: 429 });
    const fn = vi.fn().mockRejectedValue(err);

    vi.useFakeTimers();
    let caught: Error | undefined;
    const promise = withStripeRetry(fn).catch((e: Error) => { caught = e; });
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    expect(caught?.message).toBe("persistent 429");
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("does NOT retry on ECONNRESET — retryable network error", async () => {
    // ECONNRESET IS retryable (network teardown)
    const err = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    vi.useFakeTimers();
    const promise = withStripeRetry(fn);
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
