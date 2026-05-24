// Supabase Edge Function — outcome metrics incremental rollup
// Schedule: */15 * * * *  (every 15 minutes)
// Enqueues one outcomes_rollup_partition job per day needing rollup.
// The job handler calls rollup_outcomes_window(date) RPC which is idempotent.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  const results: string[] = [];
  const now = new Date();

  // Roll up today and yesterday (yesterday catches any late-arriving emits).
  for (const daysBack of [0, 1]) {
    const target = new Date(now);
    target.setUTCDate(target.getUTCDate() - daysBack);
    const dateStr = target.toISOString().slice(0, 10);

    // Enqueue via jobs queue (idempotent: same date + type won't double-enqueue
    // because the handler itself is idempotent via ON CONFLICT DO UPDATE on rollup).
    const { error } = await supabase.from("jobs").insert({
      type: "outcomes_rollup_partition",
      payload: { date: dateStr },
      idempotency_key: `outcomes_rollup:${dateStr}:${Math.floor(Date.now() / (15 * 60 * 1000))}`,
      max_attempts: 3,
    });

    if (error && (error as { code?: string }).code !== "23505") {
      // 23505 = unique_violation on idempotency_key — already enqueued this window, skip
      console.error(JSON.stringify({ event: "outcomes_rollup.enqueue_error", date: dateStr, error: error.message }));
    } else {
      results.push(dateStr);
      console.log(JSON.stringify({ event: "outcomes_rollup.enqueued", date: dateStr }));
    }
  }

  return new Response(JSON.stringify({ ok: true, enqueued: results }), {
    headers: { "Content-Type": "application/json" },
  });
});
