// Supabase Edge Function — monthly vendor billing cron
// Schedule: 0 1 1 * *  (1st of each month, 01:00 UTC)
// The 1-hour buffer past midnight lets edge-of-month charges settle before we snapshot.
//
// For each vendor with an approved app, computes gross_revenue_cents for the
// just-ended calendar month (direct + affiliate only; reseller-sold excluded per SPEC §3)
// and writes one vendor_billing row via the compute_vendor_billing RPC.
//
// The loop is per-vendor: a failure on one vendor is isolated — already-completed
// vendors are not re-processed (ON CONFLICT DO NOTHING in the RPC).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  // Guard: only allow calls with the service role key as Bearer token
  const authHeader = req.headers.get("Authorization") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!authHeader.startsWith("Bearer ") || authHeader.slice(7) !== serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    serviceRoleKey,
    { auth: { persistSession: false } }
  );

  // Compute the just-ended calendar month (UTC).
  // When the cron fires on the 1st of the current month, "last month" is current month - 1.
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // day 0 = last day of prev month

  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

  const periodStartStr = fmt(periodStart);
  const periodEndStr   = fmt(periodEnd);

  // Collect all distinct vendor ids that have at least one approved app
  const { data: rows, error: vendorErr } = await supabase
    .from("apps")
    .select("vendor_id")
    .eq("status", "approved");

  if (vendorErr) {
    return new Response(JSON.stringify({ error: vendorErr.message }), { status: 500 });
  }

  const vendorIds = [...new Set((rows ?? []).map((r: { vendor_id: string }) => r.vendor_id))];

  const results: { processed: string[]; skipped: string[]; errors: Array<{ vendorId: string; error: string }> } = {
    processed: [],
    skipped: [],
    errors: [],
  };

  for (const vendorId of vendorIds) {
    const { error } = await supabase.rpc("compute_vendor_billing", {
      p_vendor_id:    vendorId,
      p_period_start: periodStartStr,
      p_period_end:   periodEndStr,
    });

    if (error) {
      results.errors.push({ vendorId, error: error.message });
    } else {
      results.processed.push(vendorId);
    }
  }

  const status = results.errors.length > 0 ? 207 : 200;
  return new Response(
    JSON.stringify({
      period: { start: periodStartStr, end: periodEndStr },
      ...results,
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
});
