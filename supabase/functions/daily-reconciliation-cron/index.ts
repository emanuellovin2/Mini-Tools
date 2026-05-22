// Supabase Edge Function — daily Stripe↔DB reconciliation cron
// Schedule: 0 2 * * *  (02:00 UTC every day)
//
// Runs the reconciliation checks defined in lib/services/reconciliation.ts,
// then sends a Resend digest email to the admin.
//
// Auth: Bearer SUPABASE_SERVICE_ROLE_KEY (same pattern as monthly-billing-cron).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@17";
import { Resend } from "https://esm.sh/resend@4";

// ---------------------------------------------------------------------------
// Inline drift detection (Edge Functions cannot import from /lib)
// ---------------------------------------------------------------------------

type DriftItem = {
  type: "subscription_drift" | "missing_transfer" | "stale_webhook";
  stripe_id: string | null;
  db_status?: string;
  stripe_status?: string;
  message: string;
  detected_at: string;
};

async function runReconciliation(
  supabase: ReturnType<typeof createClient>,
  stripe: Stripe
): Promise<{ status: "ok" | "drift_found" | "failed"; drift: DriftItem[]; error?: string }> {
  const now = new Date().toISOString();
  const drift: DriftItem[] = [];

  try {
    // 1. Subscription drift
    const { data: activeSubs } = await supabase
      .from("subscriptions")
      .select("id, stripe_subscription_id, status")
      .in("status", ["active", "trialing", "past_due"])
      .limit(200);

    for (const sub of activeSubs ?? []) {
      if (!sub.stripe_subscription_id) continue;
      try {
        const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        if (stripeSub.status === "canceled" || stripeSub.status === "incomplete_expired") {
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
        if ((e as { statusCode?: number })?.statusCode === 404) {
          drift.push({
            type: "subscription_drift",
            stripe_id: sub.stripe_subscription_id,
            db_status: sub.status,
            stripe_status: "not_found",
            message: `DB shows "${sub.status}" but Stripe returned 404`,
            detected_at: now,
          });
        }
      }
    }

    // 2. Missing transfers (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: revenueEvents } = await supabase
      .from("vendor_revenue_events")
      .select("stripe_invoice_id")
      .gt("amount_cents", 0)
      .gte("occurred_at", sevenDaysAgo)
      .not("stripe_invoice_id", "is", null);

    const invoiceIds = [
      ...new Set(
        (revenueEvents ?? [])
          .map((r: { stripe_invoice_id: string | null }) => r.stripe_invoice_id)
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
            message: `invoice.paid recorded in DB but no Stripe transfer found for ${invoiceId}`,
            detected_at: now,
          });
        }
      } catch {
        // Skip on transient Stripe errors
      }
    }

    // 3. Stale webhooks (received but not processed for >1 hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: staleWebhooks } = await supabase
      .from("webhook_events")
      .select("id, type")
      .eq("status", "received")
      .lt("received_at", oneHourAgo)
      .limit(20);

    for (const wh of staleWebhooks ?? []) {
      drift.push({
        type: "stale_webhook",
        stripe_id: wh.id,
        message: `Webhook ${wh.id} (${wh.type}) stuck in "received" for >1h`,
        detected_at: now,
      });
    }

    const status = drift.length > 0 ? "drift_found" : "ok";
    await supabase.from("reconciliation_runs").insert({
      status,
      drift_items: drift,
      drift_count: drift.length,
    });

    return { status, drift };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await supabase.from("reconciliation_runs").insert({
      status: "failed",
      drift_items: [],
      drift_count: 0,
      error,
    }).catch(() => {});
    return { status: "failed", drift: [], error };
  }
}

// ---------------------------------------------------------------------------
// Edge Function entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  // Auth guard
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

  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
    apiVersion: "2025-04-30.basil",
  });

  const runAt = new Date().toISOString();
  const { status, drift, error } = await runReconciliation(supabase, stripe);

  // Send digest email — degrade silently if Resend is unavailable
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const adminEmail = Deno.env.get("ADMIN_EMAIL");
  const appUrl = Deno.env.get("NEXT_PUBLIC_APP_URL") ?? "";
  const fromAddress = Deno.env.get("EMAIL_FROM") ?? "noreply@platform.local";

  if (resendKey && adminEmail) {
    try {
      const resend = new Resend(resendKey);
      const subject =
        drift.length === 0
          ? `[PLATFORM] Reconciliation OK — ${runAt.slice(0, 10)}`
          : `[PLATFORM] Reconciliation drift — ${drift.length} item(s) — ${runAt.slice(0, 10)}`;

      const itemRows = drift
        .slice(0, 20)
        .map((d) => `<li><strong>${d.type}</strong> — ${d.message}</li>`)
        .join("\n");
      const overflowNote =
        drift.length > 20
          ? `<p>…and ${drift.length - 20} more. See the reconciliation dashboard.</p>`
          : "";

      await resend.emails.send({
        from: fromAddress,
        to: adminEmail,
        subject,
        html:
          drift.length === 0
            ? `<p>Daily reconciliation at ${runAt} found no drift. ✅</p>`
            : `
            <p>Daily reconciliation at <strong>${runAt}</strong> found
            <strong>${drift.length}</strong> drift item(s).</p>
            <ul>${itemRows}</ul>
            ${overflowNote}
            <p><a href="${appUrl}/admin/reconciliation">View reconciliation dashboard →</a></p>
          `,
      });
    } catch {
      // Email failure must not fail the cron job
    }
  }

  console.log(
    JSON.stringify({
      level: status === "failed" ? "error" : drift.length > 0 ? "warn" : "info",
      ts: runAt,
      event: "reconciliation.run",
      status,
      drift_count: drift.length,
      ...(error ? { error } : {}),
    })
  );

  return new Response(
    JSON.stringify({ status, drift_count: drift.length, run_at: runAt }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
