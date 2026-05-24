import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import type { Json } from "@/types/supabase";
import { createAdminClient } from "@/lib/services/supabase";
import { getStripe } from "@/lib/stripe/client";
import { logWebhookEvent } from "@/lib/logger";
import {
  handleCheckoutSessionCompleted,
  handleSubscriptionUpdated,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleChargeRefunded,
  handleDisputeEvent,
  handleAccountUpdated,
  handleAccountDeauthorized,
} from "@/lib/stripe/webhook-handlers";

export const runtime = "nodejs";

type AdminClient = ReturnType<typeof createAdminClient>;

async function dispatch(event: Stripe.Event, admin: AdminClient): Promise<void> {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutSessionCompleted(obj as Stripe.Checkout.Session, admin);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await handleSubscriptionUpdated(obj as Stripe.Subscription, admin);
      break;
    case "invoice.paid":
      await handleInvoicePaid(obj as Stripe.Invoice, admin, event.id);
      break;
    case "invoice.payment_failed":
      await handleInvoicePaymentFailed(obj as Stripe.Invoice, admin);
      break;
    case "charge.refunded":
      await handleChargeRefunded(obj as Stripe.Charge, admin, event.id);
      break;
    case "charge.dispute.created":
    case "charge.dispute.closed":
      await handleDisputeEvent(obj as Stripe.Dispute, event.type, admin);
      break;
    case "account.updated":
      await handleAccountUpdated(obj as Stripe.Account, admin);
      break;
    case "account.application.deauthorized":
      // Connected account id is on the event, not the object
      await handleAccountDeauthorized(event.account ?? "", admin);
      break;
    default:
      break;
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET not set" }, { status: 500 });
  }

  // 5-minute tolerance — rejects replayed webhooks with a stale timestamp
  const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300;

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      rawBody,
      sig,
      webhookSecret,
      STRIPE_TIMESTAMP_TOLERANCE_SECONDS
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Signature verification failed";
    logWebhookEvent({ event_id: "unknown", event_type: "unknown", outcome: "failed", latency_ms: 0, error: msg });
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const admin = createAdminClient();

  // Atomic claim: only the invocation that successfully INSERTs the row owns processing.
  // Two simultaneous Stripe retries can both pass a "select first, then upsert" check
  // before either commits — Postgres serializes the inserts via the PK, so only one wins.
  const nowIso = new Date().toISOString();
  const insertRes = await admin
    .from("webhook_events")
    .insert({
      id: event.id,
      type: event.type,
      payload: event.data.object as unknown as Json,
      status: "received",
      received_at: nowIso,
    })
    .select("id")
    .maybeSingle();

  const claimed = !!insertRes.data && !insertRes.error;

  if (!claimed) {
    // Row already exists. Decide based on current state.
    const { data: existing } = await admin
      .from("webhook_events")
      .select("status, received_at")
      .eq("id", event.id)
      .maybeSingle();

    if (existing?.status === "processed") {
      logWebhookEvent({ event_id: event.id, event_type: event.type, outcome: "skipped", latency_ms: 0 });
      return NextResponse.json({ ok: true });
    }

    // "received" — another worker is processing this event. Don't double-fire handlers
    // (their side effects, especially RPCs without per-event idempotency, will diverge).
    // If the holding worker crashed mid-flight, the `received_at` will be old; reclaim then.
    const STALE_MS = 2 * 60 * 1000;
    const ageMs = existing?.received_at
      ? Date.now() - new Date(existing.received_at).getTime()
      : Number.POSITIVE_INFINITY;

    if (existing?.status === "received" && ageMs < STALE_MS) {
      logWebhookEvent({
        event_id: event.id,
        event_type: event.type,
        outcome: "skipped",
        latency_ms: 0,
        error: "in_progress",
      });
      return NextResponse.json({ ok: true });
    }

    // status === "failed" or stale "received": reclaim and reprocess.
    await admin
      .from("webhook_events")
      .update({ status: "received", received_at: nowIso, error: null })
      .eq("id", event.id);
  }

  const startMs = Date.now();

  try {
    await dispatch(event, admin);
    const latency_ms = Date.now() - startMs;
    await admin
      .from("webhook_events")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("id", event.id);
    logWebhookEvent({ event_id: event.id, event_type: event.type, outcome: "processed", latency_ms });
  } catch (err) {
    const latency_ms = Date.now() - startMs;
    const errorMsg = err instanceof Error ? err.message : String(err);
    await admin
      .from("webhook_events")
      .update({ status: "failed", error: errorMsg })
      .eq("id", event.id);
    logWebhookEvent({ event_id: event.id, event_type: event.type, outcome: "failed", latency_ms, error: errorMsg });
    // Return 500 so Stripe retries
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
