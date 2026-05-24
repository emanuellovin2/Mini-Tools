// Wraps a Stripe SDK call with exponential backoff + jitter.
// Use on every Stripe call from cron paths (transfers, settlement, connect).
// ONLY safe with idempotent calls — always pass idempotency keys upstream.
// Interactive/webhook paths should let Stripe's own retry handle transient errors.

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { statusCode?: number; code?: string; type?: string };
  if (e.statusCode === 429) return true;      // rate limit
  if (e.statusCode != null && e.statusCode >= 500) return true; // Stripe 5xx
  if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") return true;
  return false;
}

function jitter(ms: number): number {
  return ms + Math.random() * ms * 0.3;
}

export async function withStripeRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) throw err;
      const delay = jitter(BASE_DELAY_MS * 2 ** (attempt - 1));
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "stripe.retry",
          attempt,
          delay_ms: Math.round(delay),
          error: (err as Error).message ?? String(err),
          ts: new Date().toISOString(),
        })
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
