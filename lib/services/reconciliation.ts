/**
 * Stripe↔DB reconciliation service.
 *
 * Checks for three categories of drift:
 * 1. subscription_drift — DB subscription is active/trialing/past_due but Stripe
 *    reports it as canceled or returns 404.
 * 2. missing_transfer — a vendor_revenue_events row (invoice.paid) exists but the
 *    corresponding Stripe transfer_group has no transfers.
 * 3. stale_webhook — a webhook_events row is stuck in "received" for >1 hour,
 *    indicating a dropped or crashed handler.
 *
 * Results are stored in reconciliation_runs and returned to the caller
 * (the daily cron sends a digest email).
 */

import { createAdminClient } from "@/lib/services/supabase";
import { getStripe } from "@/lib/stripe/client";
import type { SupabaseClient } from "@supabase/supabase-js";

// reconciliation_runs is not yet in the auto-generated types (run `npm run types`
// after `supabase db push` to regenerate). Until then, we cast to bypass the
// typed .from() overloads — all other tables remain strictly typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export type DriftItem = {
  type:
    | "subscription_drift"
    | "missing_transfer"
    | "stale_webhook"
    | "credit_balance_drift"
    | "usage_partner_payable_drift";
  stripe_id: string | null;
  db_status?: string;
  stripe_status?: string;
  message: string;
  detected_at: string;
};

export type ReconciliationResult = {
  status: "ok" | "drift_found" | "failed";
  drift_items: DriftItem[];
  run_id: string | null;
  error?: string;
};

export async function runReconciliation(): Promise<ReconciliationResult> {
  const admin = createAdminClient();
  const stripe = getStripe();
  const drift: DriftItem[] = [];
  const now = new Date().toISOString();

  try {
    // ------------------------------------------------------------------
    // 1. Subscription drift: DB shows active/trialing/past_due but Stripe
    //    reports canceled or 404.
    //    Cap to 200 rows to keep the cron bounded; in practice the platform
    //    shouldn't have more active subscribers than this at early scale.
    // ------------------------------------------------------------------
    const { data: activeSubs } = await admin
      .from("subscriptions")
      .select("id, stripe_subscription_id, status")
      .in("status", ["active", "trialing", "past_due"])
      .limit(200);

    for (const sub of activeSubs ?? []) {
      if (!sub.stripe_subscription_id) continue;
      try {
        const stripeSub = await stripe.subscriptions.retrieve(
          sub.stripe_subscription_id
        );
        if (
          stripeSub.status === "canceled" ||
          stripeSub.status === "incomplete_expired"
        ) {
          drift.push({
            type: "subscription_drift",
            stripe_id: sub.stripe_subscription_id,
            db_status: sub.status,
            stripe_status: stripeSub.status,
            message: `DB shows "${sub.status}" but Stripe reports "${stripeSub.status}"`,
            detected_at: now,
          });
        }
      } catch (e: unknown) {
        // Stripe returns statusCode 404 for deleted/non-existent subscriptions
        if ((e as { statusCode?: number })?.statusCode === 404) {
          drift.push({
            type: "subscription_drift",
            stripe_id: sub.stripe_subscription_id,
            db_status: sub.status,
            stripe_status: "not_found",
            message: `DB shows "${sub.status}" but Stripe returned 404 — subscription may have been deleted outside the webhook flow`,
            detected_at: now,
          });
        }
        // Other Stripe errors (rate limits, network) — skip this sub, don't
        // falsely flag it as drift. The next run will re-check.
      }
    }

    // ------------------------------------------------------------------
    // 2. Missing transfers: recent invoice.paid revenue events with no
    //    corresponding transfer in the Stripe transfer_group.
    //    Look back 7 days to catch events from the last cycle without
    //    querying the full history.
    // ------------------------------------------------------------------
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    const { data: revenueEvents } = await admin
      .from("vendor_revenue_events")
      .select("stripe_invoice_id")
      .gt("amount_cents", 0)
      .gte("occurred_at", sevenDaysAgo)
      .not("stripe_invoice_id", "is", null);

    // Deduplicate invoice IDs (one revenue event per invoice)
    const invoiceIds = [
      ...new Set(
        (revenueEvents ?? [])
          .map((r) => r.stripe_invoice_id)
          .filter((id): id is string => !!id)
      ),
    ];

    for (const invoiceId of invoiceIds) {
      try {
        const transfers = await stripe.transfers.list({
          transfer_group: `invoice_${invoiceId}`,
          limit: 1,
        });
        if (transfers.data.length === 0) {
          drift.push({
            type: "missing_transfer",
            stripe_id: invoiceId,
            message: `invoice.paid recorded in DB for ${invoiceId} but no Stripe transfer found in transfer_group`,
            detected_at: now,
          });
        }
      } catch {
        // Skip on Stripe API errors — conservative, don't false-positive
      }
    }

    // ------------------------------------------------------------------
    // 3. Stale webhooks: events stuck in "received" for >1 hour indicate
    //    the handler crashed mid-flight or was never dispatched.
    // ------------------------------------------------------------------
    const oneHourAgo = new Date(
      Date.now() - 60 * 60 * 1000
    ).toISOString();

    const { data: staleWebhooks } = await admin
      .from("webhook_events")
      .select("id, type")
      .eq("status", "received")
      .lt("received_at", oneHourAgo)
      .limit(20);

    for (const wh of staleWebhooks ?? []) {
      drift.push({
        type: "stale_webhook",
        stripe_id: wh.id,
        message: `Webhook event ${wh.id} (${wh.type}) has been in "received" state for >1h — handler may have crashed`,
        detected_at: now,
      });
    }

    // ------------------------------------------------------------------
    // 4. Usage credit integrity: Σ topups − Σ drawdowns − Σ refunds === Σ wallet balances
    //    Flag if drift exceeds $1 (100 cents) to allow for rounding.
    // ------------------------------------------------------------------
    try {
      const anyAdmin2 = admin as AnyClient;
      const [topupsRes, drawdownsRes, refundsRes, walletsRes] = await Promise.all([
        anyAdmin2
          .from("credit_transactions")
          .select("amount_cents")
          .eq("type", "topup"),
        anyAdmin2
          .from("credit_transactions")
          .select("amount_cents")
          .eq("type", "drawdown"),
        anyAdmin2
          .from("credit_transactions")
          .select("amount_cents")
          .eq("type", "refund"),
        anyAdmin2.from("credit_wallets").select("balance_cents"),
      ]);

      const sumTopups = ((topupsRes.data ?? []) as Array<{ amount_cents: number }>).reduce(
        (s, r) => s + r.amount_cents, 0
      );
      const sumDrawdowns = ((drawdownsRes.data ?? []) as Array<{ amount_cents: number }>).reduce(
        (s, r) => s + r.amount_cents, 0
      );
      const sumRefunds = ((refundsRes.data ?? []) as Array<{ amount_cents: number }>).reduce(
        (s, r) => s + r.amount_cents, 0
      );
      const sumBalances = ((walletsRes.data ?? []) as Array<{ balance_cents: number }>).reduce(
        (s, r) => s + r.balance_cents, 0
      );

      const expected = sumTopups - sumDrawdowns - sumRefunds;
      const delta = Math.abs(expected - sumBalances);
      if (delta > 100) {
        drift.push({
          type: "credit_balance_drift",
          stripe_id: null,
          message: `Usage credit integrity: expected balance=${expected}¢ (topups-drawdowns-refunds), actual sum of wallets=${sumBalances}¢, delta=${delta}¢`,
          detected_at: now,
        });
      }
    } catch {
      // Non-fatal — usage tables may not exist in all environments yet
    }

    // ------------------------------------------------------------------
    // Persist
    // ------------------------------------------------------------------
    const status: ReconciliationResult["status"] =
      drift.length > 0 ? "drift_found" : "ok";

    const anyAdmin = admin as AnyClient;
    const { data: runRow } = await anyAdmin
      .from("reconciliation_runs")
      .insert({
        status,
        drift_items: drift,
        drift_count: drift.length,
      })
      .select("id")
      .single();

    return { status, drift_items: drift, run_id: (runRow as { id: string } | null)?.id ?? null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    // Try to persist the failure; if this also fails just swallow it
    const anyAdmin = admin as AnyClient;
    let runRow: { id: string } | null = null;
    try {
      const { data } = await anyAdmin
        .from("reconciliation_runs")
        .insert({ status: "failed", drift_items: [], drift_count: 0, error })
        .select("id")
        .single();
      runRow = data as { id: string } | null;
    } catch {
      // Swallow — we're already in the error path
    }

    return { status: "failed", drift_items: [], run_id: runRow?.id ?? null, error };
  }
}

// ---------------------------------------------------------------------------
// Query helpers for the admin UI
// ---------------------------------------------------------------------------

export type ReconciliationRun = {
  id: string;
  run_at: string;
  status: "ok" | "drift_found" | "failed";
  drift_count: number;
  drift_items: DriftItem[];
  error: string | null;
  created_at: string;
};

type RawRunRow = {
  id: string;
  run_at: string;
  status: string;
  drift_count: number;
  drift_items: unknown;
  error: string | null;
  created_at: string;
};

export async function getReconciliationRuns({
  page = 1,
  pageSize = 20,
}: { page?: number; pageSize?: number } = {}): Promise<{
  runs: ReconciliationRun[];
  total: number;
  totalPages: number;
}> {
  const anyAdmin = createAdminClient() as AnyClient;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await anyAdmin
    .from("reconciliation_runs")
    .select("id, run_at, status, drift_count, drift_items, error, created_at", {
      count: "exact",
    })
    .order("run_at", { ascending: false })
    .range(from, to);

  if (error) throw new Error(`getReconciliationRuns: ${(error as { message: string }).message}`);

  return {
    runs: ((data as RawRunRow[]) ?? []).map((r) => ({
      id: r.id,
      run_at: r.run_at,
      status: r.status as ReconciliationRun["status"],
      drift_count: r.drift_count,
      drift_items: (r.drift_items as DriftItem[]) ?? [],
      error: r.error,
      created_at: r.created_at,
    })),
    total: (count as number | null) ?? 0,
    totalPages: Math.ceil(((count as number | null) ?? 0) / pageSize),
  };
}
