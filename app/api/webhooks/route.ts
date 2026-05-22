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

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Signature verification failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const admin = createAdminClient();

  // Idempotency gate — skip already-processed events
  const { data: existing } = await admin
    .from("webhook_events")
    .select("status")
    .eq("id", event.id)
    .maybeSingle();

  if (existing?.status === "processed") {
    logWebhookEvent({ event_id: event.id, event_type: event.type, outcome: "skipped", latency_ms: 0 });
    return NextResponse.json({ ok: true });
  }

  // Record the event before processing so Stripe retries find it
  await admin.from("webhook_events").upsert({
    id: event.id,
    type: event.type,
    payload: event.data.object as unknown as Json,
    status: "received",
    received_at: new Date().toISOString(),
  });

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
