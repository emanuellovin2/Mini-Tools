// Supabase Edge Function — analytics daily rollup
// Schedule: 0 3 * * *  (03:00 UTC — after daily-reconciliation-cron at 02:00)
// Rolls up analytics_events from yesterday into analytics_daily.
// Idempotent: calling again for the same date is safe (ON CONFLICT DO UPDATE).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  const results: string[] = [];

  // Rollup yesterday (always) and 2 days ago (idempotent catch-up).
  const now = new Date();
  for (const daysBack of [1, 2]) {
    const target = new Date(now);
    target.setUTCDate(target.getUTCDate() - daysBack);
    const dateStr = target.toISOString().slice(0, 10);

    const { error } = await supabase.rpc("rollup_analytics_day", { p_date: dateStr });
    if (error) {
      console.error(JSON.stringify({ event: "rollup.error", date: dateStr, error: error.message }));
    } else {
      results.push(dateStr);
      console.log(JSON.stringify({ event: "rollup.ok", date: dateStr }));
    }
  }

  return new Response(JSON.stringify({ ok: true, rolled_up: results }), {
    headers: { "Content-Type": "application/json" },
  });
});
