import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/supabase";
import { getStripe } from "./client";
import { stripeStatusToSubscriptionStatus } from "./entitlements";
import {
  getVendorCutBps,
  transferVendorShare,
  transferAffiliateShare,
  computeResellerSplit,
  transferResellerVendorFloor,
  transferResellerShare,
  reverseTransfers,
} from "./transfers";
import { recordAttribution } from "@/lib/services/affiliate";
import {
  upsertResellerSubscription,
  isResellerActive,
  pauseOffersOnLapse,
} from "@/lib/services/reseller";
import { logMoneyFlow, logAccessEvent } from "@/lib/logger";
import {
  sendSubscriptionReceipt,
  sendPaymentFailedNotice,
} from "@/lib/email/resend";

type AdminClient = SupabaseClient<Database>;

async function writeAuditLog(
  admin: AdminClient,
  entry: {
    actor_id: string | null;
    actor_role: string;
    action: string;
    entity_type: string;
    entity_id?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await admin.from("audit_log").insert({
    actor_id: entry.actor_id ?? null,
    actor_role: entry.actor_role,
    action: entry.action,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id ?? null,
    metadata: (entry.metadata ?? null) as unknown as Json,
  });
}

// In Stripe v22, current_period_end moved from Subscription to SubscriptionItem.
function getSubPeriodEnd(sub: Stripe.Subscription): number {
  const item = sub.items.data[0];
  if (!item) throw new Error(`Subscription ${sub.id} has no items`);
  return item.current_period_end;
}

export async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  admin: AdminClient
): Promise<void> {
  if (session.mode !== "subscription") return;

  const meta = session.metadata ?? {};

  // Reseller platform $19/mo subscription — write to reseller_subscriptions and return.
  if (meta.reseller_platform_sub === "true") {
    const { reseller_id } = meta;
    if (!reseller_id) throw new Error(`Missing reseller_id in checkout session ${session.id}`);
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(session.subscription as string);
    const status = stripeStatusToSubscriptionStatus(sub.status);
    const periodEnd = getSubPeriodEnd(sub);
    await upsertResellerSubscription({
      resellerId: reseller_id,
      stripeSubId: sub.id,
      status,
      currentPeriodEnd: new Date(periodEnd * 1000).toISOString(),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    });
    await writeAuditLog(admin, {
      actor_id: null,
      actor_role: "system",
      action: "reseller_subscription.created",
      entity_type: "reseller_subscriptions",
      entity_id: sub.id,
      metadata: { reseller_id, status },
    });
    return;
  }

  // Reseller storefront checkout — buyer subscribing via a reseller offer.
  if (meta.reseller_offer_id) {
    const { buyer_id, app_id, anon_user_id, reseller_id, reseller_offer_id, vendor_floor_snapshot_cents } = meta;
    if (!buyer_id || !app_id || !anon_user_id || !reseller_id || !reseller_offer_id || !vendor_floor_snapshot_cents) {
      throw new Error(`Missing reseller metadata in checkout session ${session.id}`);
    }
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(session.subscription as string);
    const status = stripeStatusToSubscriptionStatus(sub.status);
    const priceCents = sub.items.data[0]?.price?.unit_amount ?? 0;
    const periodEnd = getSubPeriodEnd(sub);

    const { error, data: upsertedRows } = await admin
      .from("subscriptions")
      .upsert(
        {
          buyer_id,
          app_id,
          stripe_subscription_id: sub.id,
          stripe_customer_id: session.customer as string,
          status,
          price_cents: priceCents,
          currency: sub.currency,
          anon_user_id,
          cancel_at_period_end: sub.cancel_at_period_end,
          current_period_end: new Date(periodEnd * 1000).toISOString(),
          reseller_id,
          reseller_offer_id,
          vendor_floor_snapshot_cents: Number(vendor_floor_snapshot_cents),
          affiliate_id: null, // reseller takes priority (SPEC §4)
        },
        { onConflict: "stripe_subscription_id" }
      )
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`reseller subscriptions upsert failed: ${error.message}`);

    await writeAuditLog(admin, {
      actor_id: null,
      actor_role: "system",
      action: "subscription.created.reseller",
      entity_type: "subscriptions",
      entity_id: sub.id,
      metadata: { buyer_id, app_id, status, reseller_id, reseller_offer_id },
    });
    logAccessEvent({ action: "subscription.created.reseller", entity_id: sub.id, app_id, status });
    return;
  }

  const { buyer_id, app_id, anon_user_id, affiliate_id, aff_code } = meta;
  if (!buyer_id || !app_id || !anon_user_id) {
    throw new Error(`Missing metadata in checkout session ${session.id}`);
  }

  const subscriptionId = session.subscription as string;
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const status = stripeStatusToSubscriptionStatus(sub.status);
  const priceCents = sub.items.data[0]?.price?.unit_amount ?? 0;
  const periodEnd = getSubPeriodEnd(sub);

  // Self-referral guard: drop affiliate attribution if buyer is the affiliate
  const resolvedAffiliateId =
    affiliate_id && affiliate_id !== buyer_id ? affiliate_id : null;
  const resolvedAffCode = resolvedAffiliateId ? aff_code : null;

  const { error, data: upsertedRows } = await admin
    .from("subscriptions")
    .upsert(
      {
        buyer_id,
        app_id,
        stripe_subscription_id: subscriptionId,
        stripe_customer_id: session.customer as string,
        status,
        price_cents: priceCents,
        currency: sub.currency,
        anon_user_id,
        cancel_at_period_end: sub.cancel_at_period_end,
        current_period_end: new Date(periodEnd * 1000).toISOString(),
        affiliate_id: resolvedAffiliateId,
      },
      { onConflict: "stripe_subscription_id" }
    )
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`subscriptions upsert failed: ${error.message}`);

  // Write affiliate attribution row (idempotent via UNIQUE(subscription_id))
  if (resolvedAffiliateId && resolvedAffCode && upsertedRows?.id) {
    await recordAttribution({
      subscriptionId: upsertedRows.id,
      affiliateId: resolvedAffiliateId,
      code: resolvedAffCode,
    });
    await writeAuditLog(admin, {
      actor_id: null,
      actor_role: "system",
      action: "affiliate.attribution.recorded",
      entity_type: "affiliate_attributions",
      entity_id: upsertedRows.id,
      metadata: { affiliate_id: resolvedAffiliateId, code: resolvedAffCode, app_id },
    });
  }

  await writeAuditLog(admin, {
    actor_id: null,
    actor_role: "system",
    action: "subscription.created",
    entity_type: "subscriptions",
    entity_id: subscriptionId,
    metadata: { buyer_id, app_id, status, affiliate_id: resolvedAffiliateId ?? undefined },
  });

  logAccessEvent({ action: "subscription.created", entity_id: subscriptionId, app_id, status });
}

export async function handleSubscriptionUpdated(
  sub: Stripe.Subscription,
  admin: AdminClient
): Promise<void> {
  const status = stripeStatusToSubscriptionStatus(sub.status);
  const periodEnd = getSubPeriodEnd(sub);

  // Check if this is a reseller platform $19/mo subscription.
  const { data: resellerPlatformSub } = await admin
    .from("reseller_subscriptions")
    .select("*")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();
  if (resellerPlatformSub) {
    const wasActive = isResellerActive(resellerPlatformSub.status);
    const nowActive = isResellerActive(status);

    await upsertResellerSubscription({
      resellerId: resellerPlatformSub.reseller_id,
      stripeSubId: sub.id,
      status,
      currentPeriodEnd: new Date(periodEnd * 1000).toISOString(),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    });

    // If the reseller just lapsed, pause all their offers.
    if (wasActive && !nowActive) {
      await pauseOffersOnLapse(resellerPlatformSub.reseller_id);
      await writeAuditLog(admin, {
        actor_id: null,
        actor_role: "system",
        action: "reseller_subscription.lapsed.offers_paused",
        entity_type: "reseller_subscriptions",
        entity_id: sub.id,
        metadata: { reseller_id: resellerPlatformSub.reseller_id, status },
      });
    }

    await writeAuditLog(admin, {
      actor_id: null,
      actor_role: "system",
      action: "reseller_subscription.updated",
      entity_type: "reseller_subscriptions",
      entity_id: sub.id,
      metadata: { reseller_id: resellerPlatformSub.reseller_id, status },
    });
    return;
  }

  // Regular buyer subscription update.
  const { error } = await admin
    .from("subscriptions")
    .update({
      status,
      current_period_end: new Date(periodEnd * 1000).toISOString(),
      cancel_at_period_end: sub.cancel_at_period_end,
      canceled_at: sub.canceled_at
        ? new Date(sub.canceled_at * 1000).toISOString()
        : null,
    })
    .eq("stripe_subscription_id", sub.id);
  if (error) throw new Error(`subscription update failed: ${error.message}`);

  await writeAuditLog(admin, {
    actor_id: null,
    actor_role: "system",
    action: "subscription.updated",
    entity_type: "subscriptions",
    entity_id: sub.id,
    metadata: { status, cancel_at_period_end: sub.cancel_at_period_end },
  });

  logAccessEvent({ action: "subscription.updated", entity_id: sub.id, status });
}

export async function handleInvoicePaid(
  invoice: Stripe.Invoice,
  admin: AdminClient,
  eventId: string
): Promise<void> {
  if (!invoice.id) return;

  // In Stripe v22, subscription lives under invoice.parent.subscription_details.subscription
  const parent = invoice.parent as Stripe.Invoice.Parent | null;
  const subscriptionId =
    parent?.type === "subscription_details"
      ? (parent.subscription_details?.subscription as string | null)
      : null;

  if (!subscriptionId) return; // Non-subscription invoice — skip

  // Check if this is a reseller platform $19/mo invoice — just update status, no app transfer.
  const { data: resellerPlatformSub } = await admin
    .from("reseller_subscriptions")
    .select("*")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  if (resellerPlatformSub) {
    await upsertResellerSubscription({
      resellerId: resellerPlatformSub.reseller_id,
      stripeSubId: subscriptionId,
      status: "active",
      currentPeriodEnd: resellerPlatformSub.current_period_end,
      cancelAtPeriodEnd: resellerPlatformSub.cancel_at_period_end,
      canceledAt: resellerPlatformSub.canceled_at,
    });
    await writeAuditLog(admin, {
      actor_id: null,
      actor_role: "system",
      action: "reseller_subscription.invoice.paid",
      entity_type: "reseller_subscriptions",
      entity_id: subscriptionId,
      metadata: { reseller_id: resellerPlatformSub.reseller_id, amount_cents: invoice.amount_paid },
    });
    return;
  }

  const invoiceId = invoice.id;
  const amountCents = invoice.amount_paid;

  // Mark subscription active on successful payment
  await admin
    .from("subscriptions")
    .update({ status: "active" })
    .eq("stripe_subscription_id", subscriptionId);

  // Resolve subscription row — DB first, Stripe metadata fallback for out-of-order events
  let appId: string | null = null;
  let isResellerSale = false;
  let affiliateIdForTransfer: string | null = null;
  let resellerId: string | null = null;
  let vendorFloorSnapshotCents: number | null = null;
  const { data: subRow } = await admin
    .from("subscriptions")
    .select("app_id, reseller_id, affiliate_id, vendor_floor_snapshot_cents")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (subRow?.app_id) {
    appId = subRow.app_id;
    isResellerSale = !!subRow.reseller_id;
    affiliateIdForTransfer = subRow.affiliate_id ?? null;
    resellerId = subRow.reseller_id ?? null;
    vendorFloorSnapshotCents = subRow.vendor_floor_snapshot_cents ?? null;
  } else {
    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
    appId = stripeSub.metadata?.app_id ?? null;
  }

  if (!appId) throw new Error(`Cannot resolve app_id for subscription ${subscriptionId}`);

  const { data: app } = await admin
    .from("apps")
    .select("vendor_id")
    .eq("id", appId)
    .single();
  if (!app) throw new Error(`App not found for invoice ${invoiceId}`);

  const { data: vendorProfile } = await admin
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", app.vendor_id)
    .single();
  if (!vendorProfile?.stripe_account_id) {
    throw new Error(`Vendor ${app.vendor_id} has no Stripe account — cannot transfer`);
  }

  // ── Reseller-sold: fixed vendor floor + reseller markup + 5% platform (SPEC §4b, §11) ──
  let vendorTransferId: string;
  let vendorShareCents: number;
  let resellerTransferId: string | null = null;
  let resellerShareCents: number | null = null;
  let cutBps: number | null = null;
  let affiliateShareCents: number | null = null;
  let affiliateTransferId: string | null = null;

  if (isResellerSale && resellerId !== null && vendorFloorSnapshotCents !== null) {
    const split = computeResellerSplit(amountCents, vendorFloorSnapshotCents);
    vendorShareCents = split.vendorShareCents;

    const vendorResult = await transferResellerVendorFloor({
      invoiceId,
      vendorFloorCents: vendorFloorSnapshotCents,
      vendorId: app.vendor_id,
      stripeAccountId: vendorProfile.stripe_account_id,
    });
    vendorTransferId = vendorResult.transferId;

    if (split.resellerShareCents > 0) {
      const { data: resellerProfile } = await admin
        .from("profiles")
        .select("stripe_account_id, payouts_enabled")
        .eq("id", resellerId)
        .single();

      if (resellerProfile?.stripe_account_id && resellerProfile.payouts_enabled) {
        const resellerResult = await transferResellerShare({
          invoiceId,
          resellerShareCents: split.resellerShareCents,
          resellerId,
          stripeAccountId: resellerProfile.stripe_account_id,
        });
        resellerTransferId = resellerResult.transferId;
        resellerShareCents = split.resellerShareCents;

        await writeAuditLog(admin, {
          actor_id: null,
          actor_role: "system",
          action: "reseller.transfer.created",
          entity_type: "subscriptions",
          entity_id: subscriptionId,
          metadata: {
            invoice_id: invoiceId,
            reseller_id: resellerId,
            reseller_share_cents: split.resellerShareCents,
            transfer_id: resellerTransferId,
          },
        });
        logMoneyFlow({
          action: "reseller.transfer.created",
          entity_id: subscriptionId,
          invoice_id: invoiceId,
          amount_cents: split.resellerShareCents,
          transfer_id: resellerTransferId,
        });
      }
    }
  } else {
    // ── Direct / affiliate sale: tier-based vendor share ────────────────────
    cutBps = await getVendorCutBps(app.vendor_id);
    const result = await transferVendorShare({
      invoiceId,
      amountCents,
      vendorId: app.vendor_id,
      stripeAccountId: vendorProfile.stripe_account_id,
      cutBps,
    });
    vendorTransferId = result.transferId;
    vendorShareCents = result.vendorShareCents;

    if (affiliateIdForTransfer) {
      const { data: affiliateProfile } = await admin
        .from("profiles")
        .select("stripe_account_id, charges_enabled")
        .eq("id", affiliateIdForTransfer)
        .single();

      if (affiliateProfile?.stripe_account_id && affiliateProfile.charges_enabled) {
        const affResult = await transferAffiliateShare({
          invoiceId,
          amountCents,
          affiliateId: affiliateIdForTransfer,
          stripeAccountId: affiliateProfile.stripe_account_id,
          cutBps,
        });
        affiliateShareCents = affResult.affiliateShareCents;
        affiliateTransferId = affResult.transferId;

        await writeAuditLog(admin, {
          actor_id: null,
          actor_role: "system",
          action: "affiliate.transfer.created",
          entity_type: "affiliate_attributions",
          entity_id: subscriptionId,
          metadata: {
            invoice_id: invoiceId,
            affiliate_id: affiliateIdForTransfer,
            affiliate_share_cents: affiliateShareCents,
            transfer_id: affiliateTransferId,
            cut_bps: cutBps,
          },
        });
        logMoneyFlow({
          action: "affiliate.transfer.created",
          entity_id: subscriptionId,
          invoice_id: invoiceId,
          amount_cents: affiliateShareCents,
          transfer_id: affiliateTransferId,
          cut_bps: cutBps,
        });
      }
    }
  }

  // Link PaymentIntent → transfer_group so charge.refunded can find the invoice
  const stripe = getStripe();
  const expandedInvoice = await stripe.invoices.retrieve(invoiceId, {
    expand: ["payments.data.payment.payment_intent"],
  });
  const paymentIntentId = (() => {
    const payment = expandedInvoice.payments?.data?.[0]?.payment;
    if (!payment) return null;
    const pi = payment.payment_intent;
    return typeof pi === "string" ? pi : pi?.id ?? null;
  })();

  if (paymentIntentId) {
    await stripe.paymentIntents.update(paymentIntentId, {
      transfer_group: `invoice_${invoiceId}`,
    });
  }

  // Record revenue event for monthly tier cron (idempotent via stripe_event_id UNIQUE)
  await admin.from("vendor_revenue_events").upsert(
    {
      vendor_id: app.vendor_id,
      amount_cents: amountCents,
      is_reseller_sale: isResellerSale,
      stripe_invoice_id: invoiceId,
      stripe_event_id: eventId,
      occurred_at: new Date().toISOString(),
    },
    { onConflict: "stripe_event_id", ignoreDuplicates: true }
  );

  await writeAuditLog(admin, {
    actor_id: null,
    actor_role: "system",
    action: "invoice.paid",
    entity_type: "subscriptions",
    entity_id: subscriptionId,
    metadata: {
      invoice_id: invoiceId,
      amount_cents: amountCents,
      vendor_share_cents: vendorShareCents,
      transfer_id: vendorTransferId,
      ...(isResellerSale
        ? {
            reseller_id: resellerId,
            reseller_share_cents: resellerShareCents,
            reseller_transfer_id: resellerTransferId,
            vendor_floor_cents: vendorFloorSnapshotCents,
          }
        : {
            cut_bps: cutBps,
            ...(affiliateIdForTransfer
              ? {
                  affiliate_id: affiliateIdForTransfer,
                  affiliate_share_cents: affiliateShareCents,
                  affiliate_transfer_id: affiliateTransferId,
                }
              : {}),
          }),
    },
  });

  logMoneyFlow({
    action: "invoice.paid",
    entity_id: subscriptionId,
    invoice_id: invoiceId,
    amount_cents: amountCents,
    vendor_id: app.vendor_id,
    transfer_id: vendorTransferId,
    cut_bps: cutBps ?? undefined,
    is_reseller_sale: isResellerSale,
  });

  // Send subscription receipt to buyer — look up email from Stripe customer
  try {
    const customerIdRaw = invoice.customer;
    const customerId =
      typeof customerIdRaw === "string"
        ? customerIdRaw
        : (customerIdRaw as Stripe.Customer | null)?.id ?? null;

    if (customerId) {
      const customer = await stripe.customers.retrieve(customerId);
      const buyerEmail =
        !customer.deleted && "email" in customer && customer.email
          ? customer.email
          : null;

      if (buyerEmail) {
        const { data: appRow } = await admin
          .from("apps")
          .select("name")
          .eq("id", appId)
          .single();

        await sendSubscriptionReceipt({
          buyerEmail,
          appName: appRow?.name ?? "your app",
          amountCents,
          invoiceId,
          currency: invoice.currency,
        });
      }
    }
  } catch {
    // Receipt failure must never break the webhook handler
  }
}

export async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  admin: AdminClient
): Promise<void> {
  const parent = invoice.parent as Stripe.Invoice.Parent | null;
  const subscriptionId =
    parent?.type === "subscription_details"
      ? (parent.subscription_details?.subscription as string | null)
      : null;

  // Status update comes from customer.subscription.updated; just log here.
  await writeAuditLog(admin, {
    actor_id: null,
    actor_role: "system",
    action: "invoice.payment_failed",
    entity_type: "subscriptions",
    entity_id: subscriptionId ?? null,
    metadata: { invoice_id: invoice.id, amount_due: invoice.amount_due },
  });

  logMoneyFlow({
    action: "invoice.payment_failed",
    entity_id: subscriptionId ?? null,
    invoice_id: invoice.id ?? undefined,
    amount_cents: invoice.amount_due,
  });

  // Send payment-failure/dunning notice to buyer
  try {
    const customerIdRaw = invoice.customer;
    const customerId =
      typeof customerIdRaw === "string"
        ? customerIdRaw
        : (customerIdRaw as Stripe.Customer | null)?.id ?? null;

    if (customerId && subscriptionId) {
      const stripe = getStripe();
      const customer = await stripe.customers.retrieve(customerId);
      const buyerEmail =
        !customer.deleted && "email" in customer && customer.email
          ? customer.email
          : null;

      if (buyerEmail) {
        // Resolve app name for the dunning notice
        const { data: subRow } = await admin
          .from("subscriptions")
          .select("app_id")
          .eq("stripe_subscription_id", subscriptionId)
          .maybeSingle();

        let appName = "your app";
        if (subRow?.app_id) {
          const { data: appRow } = await admin
            .from("apps")
            .select("name")
            .eq("id", subRow.app_id)
            .single();
          if (appRow?.name) appName = appRow.name;
        }

        await sendPaymentFailedNotice({
          buyerEmail,
          appName,
          amountDueCents: invoice.amount_due,
          currency: invoice.currency,
        });
      }
    }
  } catch {
    // Dunning email failure must never break the webhook handler
  }
}

export async function handleChargeRefunded(
  charge: Stripe.Charge,
  admin: AdminClient,
  eventId: string
): Promise<void> {
  // In v22, Charge.invoice was removed. Resolve the invoice via PaymentIntent → transfer_group.
  const piId = typeof charge.payment_intent === "string"
    ? charge.payment_intent
    : charge.payment_intent?.id ?? null;

  if (!piId) return;

  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(piId);
  const tg = pi.transfer_group; // e.g. "invoice_in_xxx"
  if (!tg?.startsWith("invoice_")) return;
  const invoiceId = tg.slice("invoice_".length);

  await reverseTransfers({ invoiceId, chargeId: charge.id });

  // The most recent refund is data[0] (Stripe orders newest-first).
  // Using this delta rather than cumulative amount_refunded avoids double-counting
  // when a charge has multiple partial refunds.
  const refundAmountCents = (charge.refunds as { data?: Array<{ amount: number }> } | null)
    ?.data?.[0]?.amount ?? charge.amount_refunded;

  // Look up vendor context from the invoice.paid revenue event (already recorded).
  // If not found (edge: refund arrived before invoice.paid was processed), skip the event.
  const { data: revenueRow } = await admin
    .from("vendor_revenue_events")
    .select("vendor_id, is_reseller_sale")
    .eq("stripe_invoice_id", invoiceId)
    .gt("amount_cents", 0)
    .maybeSingle();

  if (revenueRow) {
    await admin.from("vendor_revenue_events").upsert(
      {
        vendor_id: revenueRow.vendor_id,
        amount_cents: -refundAmountCents,
        is_reseller_sale: revenueRow.is_reseller_sale,
        stripe_invoice_id: invoiceId,
        stripe_charge_id: charge.id,
        stripe_event_id: eventId,
        occurred_at: new Date().toISOString(),
      },
      { onConflict: "stripe_event_id", ignoreDuplicates: true }
    );
  }

  await writeAuditLog(admin, {
    actor_id: null,
    actor_role: "system",
    action: "charge.refunded",
    entity_type: "charges",
    entity_id: charge.id,
    metadata: { invoice_id: invoiceId, amount_refunded: charge.amount_refunded },
  });

  logMoneyFlow({
    action: "charge.refunded",
    entity_id: charge.id,
    invoice_id: invoiceId,
    amount_cents: -charge.amount_refunded,
  });
}

export async function handleDisputeEvent(
  dispute: Stripe.Dispute,
  eventType: string,
  admin: AdminClient
): Promise<void> {
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  if (!chargeId) return;

  if (eventType === "charge.dispute.created") {
    const stripe = getStripe();
    const charge = await stripe.charges.retrieve(chargeId);
    const piId = typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id ?? null;

    if (piId) {
      const pi = await stripe.paymentIntents.retrieve(piId);
      const tg = pi.transfer_group;
      if (tg?.startsWith("invoice_")) {
        const invoiceId = tg.slice("invoice_".length);
        await reverseTransfers({ invoiceId, chargeId });
      }
    }
  }

  await writeAuditLog(admin, {
    actor_id: null,
    actor_role: "system",
    action: eventType,
    entity_type: "disputes",
    entity_id: dispute.id,
    metadata: { charge_id: chargeId, status: dispute.status },
  });
}

export async function handleAccountUpdated(
  account: Stripe.Account,
  admin: AdminClient
): Promise<void> {
  await admin
    .from("profiles")
    .update({
      charges_enabled: account.charges_enabled ?? false,
      payouts_enabled: account.payouts_enabled ?? false,
    })
    .eq("stripe_account_id", account.id);
}

export async function handleAccountDeauthorized(
  connectedAccountId: string,
  admin: AdminClient
): Promise<void> {
  await admin
    .from("profiles")
    .update({ charges_enabled: false, payouts_enabled: false })
    .eq("stripe_account_id", connectedAccountId);

  await writeAuditLog(admin, {
    actor_id: null,
    actor_role: "system",
    action: "account.application.deauthorized",
    entity_type: "profiles",
    entity_id: connectedAccountId,
    metadata: {},
  });
}
