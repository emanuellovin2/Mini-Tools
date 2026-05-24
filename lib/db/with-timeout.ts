import { createAdminClient } from "@/lib/services/supabase";

// Sets SET LOCAL statement_timeout for the duration of `fn`.
// Every API route + server action should wrap DB work with this.
// Webhook routes are exempt — they use their own atomic-claim budgets.
//
// Budget guide:
//   Hot reads (marketplace, search):  5_000   ms
//   Standard API / server action:    30_000   ms
//   Cron handlers:                  300_000   ms (5 min)

export async function withStatementTimeout<T>(
  ms: number,
  fn: () => Promise<T>
): Promise<T> {
  // set_statement_timeout is not yet in generated types — cast via any
  // until `npm run types` is run after migrations apply.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const start = Date.now();

  await admin.rpc("set_statement_timeout", { p_ms: ms });
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    if (elapsed > 2_000) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "db.slow_query",
          elapsed_ms: elapsed,
          timeout_ms: ms,
          ts: new Date().toISOString(),
        })
      );
    }
    return result;
  } finally {
    // Reset to default at end of request (best-effort; SET LOCAL scopes to tx anyway)
    admin.rpc("set_statement_timeout", { p_ms: 30_000 }).catch(() => void 0);
  }
}

// Convenience presets
export const withFastTimeout     = <T>(fn: () => Promise<T>) => withStatementTimeout(5_000, fn);
export const withStandardTimeout = <T>(fn: () => Promise<T>) => withStatementTimeout(30_000, fn);
export const withCronTimeout     = <T>(fn: () => Promise<T>) => withStatementTimeout(300_000, fn);
