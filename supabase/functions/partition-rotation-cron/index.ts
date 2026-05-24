// Supabase Edge Function — monthly partition rotation
// Schedule: 0 0 25 * *  (25th of each month — creates next month's partition)
// Also detaches expired partitions per the retention policy (ENGINEERING.md §6).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Retention windows per table (in months). Detach partitions older than this.
const RETENTION_MONTHS: Record<string, number> = {
  audit_log:                    18, // archive to S3 at 18 months
  jobs:                          3, // succeeded=14d but detach whole months at 3m
  vendor_webhook_deliveries:     2, // 60d raw
  analytics_events:              3, // 90d raw (future #46)
  run_steps:                     6, // 180d raw (future #42)
  notifications:                 6, // 180d raw (future #39)
  // Never detach: usage_events, credit_transactions (financial)
};

const PARTITIONED_TABLES = [
  "audit_log",
  "jobs",
  "vendor_webhook_deliveries",
  // Future tables added by #39/#40/#42/#46 — add here once created
];

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  const now = new Date();
  // Create partition for the month AFTER next (stay 2 months ahead)
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 1);

  const results: string[] = [];

  // Create next month's partitions
  for (const target of [nextMonth, nextNextMonth]) {
    const { error } = await supabase.rpc("create_next_month_partitions", {
      p_month_start: target.toISOString().slice(0, 10),
    });
    if (error) {
      console.error(JSON.stringify({ event: "rotation.create_error", month: target.toISOString(), error: error.message }));
    } else {
      results.push(`created ${target.toISOString().slice(0, 7)}`);
    }
  }

  // Detach expired partitions (no DROP — archive externally before detach)
  for (const table of PARTITIONED_TABLES) {
    const retentionMonths = RETENTION_MONTHS[table];
    if (!retentionMonths) continue;

    const cutoff = new Date(now.getFullYear(), now.getMonth() - retentionMonths, 1);
    const suffix = `${cutoff.getFullYear()}_${String(cutoff.getMonth() + 1).padStart(2, "0")}`;
    const partitionName = `${table}_${suffix}`;

    const { error } = await supabase.rpc("detach_partition_if_exists", {
      p_parent: table,
      p_partition: partitionName,
    });
    if (error) {
      console.error(JSON.stringify({ event: "rotation.detach_error", partition: partitionName, error: error.message }));
    } else {
      results.push(`detached ${partitionName}`);
    }
  }

  console.log(JSON.stringify({ event: "rotation.complete", results }));
  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
