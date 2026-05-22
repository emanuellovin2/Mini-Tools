import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/supabase";
import { getStripe } from "./client";
import { stripeStatusToSubscriptionStatus } from "./entitlements";
import {
  getVendorCutBps,
  transferVendorShare,
  transferAffiliateShare,
  computeAffiliateSplit,
  computeResellerSplit,
  transferResellerVendorFloor,
  transferResellerShare,
  reverseTransfers,
  reverseVendorTransfers,
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

// Recompute affiliate_active_mrr_cents as sum of price_cents of active/trialing subs attributed to this affiliate.
// Called on subscription status changes to keep the column accurate for tier computation.
async function recomputeAffiliateMrr(affiliateId: string, admin: AdminClient): Promise<void> {
  const { data } = await admin
    .from("subscriptions")
    .select("price_cents")
    .eq("affiliate_id", affiliateId)
    .in("status", ["active", "trialing"]);
  const mrrCents = (data ?? []).reduce((sum, s) => sum + s.price_cents, 0);
  await admin.from("profiles").update({ affiliate_active_mrr_cents: mrrCents }).eq("id", affiliateId);
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

  const { buyer_id, app_id, anon_user_id, affiliate_id, aff_code, affiliate_commission_snapshot_bps: rawSnapshotBps } = meta;
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
  const affiliateCommissionSnapshotBps =
    resolvedAffiliateId && rawSnapshotBps ? parseInt(rawSnapshotBps, 10) : null;

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
        affiliate_commission_snapshot_bps: affiliateCommissionSnapshotBps,
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

  // Recompute affiliate active MRR for newly attributed subscription.
  if (resolvedAffiliateId) {
    await recomputeAffiliateMrr(resolvedAffiliateId, admin);
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
  // Sync pause_collection → paused_until so access checks and buyer UI stay accurate.
  const pauseCollection = sub.pause_collection as { resumes_at?: number | null } | null;
  const pausedUntil = pauseCollection?.resumes_at
    ? new Date(pauseCollection.resumes_at * 1000).toISOString()
    : null;

  // Read existing pause_started_at to avoid overwriting it on subsequent webhook deliveries.
  const { data: existingSub } = await admin
    .from("subscriptions")
    .select("pause_started_at")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();

  const { error } = await admin
    .from("subscriptions")
    .update({
      status,
      current_period_end: new Date(periodEnd * 1000).toISOString(),
      cancel_at_period_end: sub.cancel_at_period_end,
      canceled_at: sub.canceled_at
        ? new Date(sub.canceled_at * 1000).toISOString()
        : null,
      paused_until: pausedUntil,
      pause_started_at: pausedUntil && !existingSub?.pause_started_at
        ? new Date().toISOString()
        : (pausedUntil ? existingSub?.pause_started_at ?? null : null),
    })
    .eq("stripe_subscription_id", sub.id);
  if (error) throw new Error(`subscription update failed: ${error.message}`);

  // Recompute affiliate active MRR when an affiliate-attributed sub changes status.
  const { data: subForMrr } = await admin
    .from("subscriptions")
    .select("affiliate_id")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();
  if (subForMrr?.affiliate_id) {
    await recomputeAffiliateMrr(subForMrr.affiliate_id, admin);
  }

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
  const grossAmountCents = invoice.amount_paid;

  const stripe = getStripe();
  let netAmountCents = grossAmountCents; // resolved below after invoice expand

  // Mark subscription active on successful payment
  await admin
    .from("subscriptions")
    .update({ status: "active" })
    .eq("stripe_subscription_id", subscriptionId);

  // Resolve subscription row — DB first, Stripe metadata fallback for out-of-order events
  let appId: string | null = null;
  let isResellerSale = false;
  let affiliateIdForTransfer: string | null = null;
  let affiliateCommissionSnapshotBps: number | null = null;
  let resellerId: string | null = null;
  let vendorFloorSnapshotCents: number | null = null;
  const { data: subRow } = await admin
    .from("subscriptions")
    .select("app_id, reseller_id, affiliate_id, vendor_floor_snapshot_cents, affiliate_commission_snapshot_bps")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (subRow?.app_id) {
    appId = subRow.app_id;
    isResellerSale = !!subRow.reseller_id;
    affiliateIdForTransfer = subRow.affiliate_id ?? null;
    affiliateCommissionSnapshotBps = subRow.affiliate_commission_snapshot_bps ?? null;
    resellerId = subRow.reseller_id ?? null;
    vendorFloorSnapshotCents = subRow.vendor_floor_snapshot_cents ?? null;
  } else {
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

  // Expand invoice once: (1) payment_intent for transfer_group linking, (2) latest_charge
  // balance_transaction to get the net amount after Stripe processing fees (#17).
  const expandedInvoice = await stripe.invoices.retrieve(invoiceId, {
    expand: ["payments.data.payment.payment_intent.latest_charge.balance_transaction"],
  });
  const paymentObj = expandedInvoice.payments?.data?.[0]?.payment;
  const piField = paymentObj?.payment_intent;
  const paymentIntentId =
    typeof piField === "string" ? piField : (piField as { id?: string } | null)?.id ?? null;
  if (grossAmountCents > 0 && piField && typeof piField === "object") {
    const pi = piField as Stripe.PaymentIntent;
    const chargeField = pi.latest_charge;
    const chargeObj =
      chargeField && typeof chargeField === "object"
        ? (chargeField as Stripe.Charge)
        : null;
    const btField = chargeObj?.balance_transaction;
    if (btField && typeof btField === "object" && btField.object === "balance_transaction") {
      netAmountCents = (btField as Stripe.BalanceTransaction).net;
    }
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
    const split = computeResellerSplit(netAmountCents, vendorFloorSnapshotCents);
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
  } else if (affiliateIdForTransfer && affiliateCommissionSnapshotBps !== null) {
    // ── Affiliate sale: vendor-funded model (SPEC §4a, #18) ─────────────────
    // Platform takes 5% flat; affiliate gets snapshotted commission %; vendor keeps the rest.
    const split = computeAffiliateSplit(netAmountCents, affiliateCommissionSnapshotBps);
    vendorShareCents = split.vendorShareCents;

    const vendorResult = await transferVendorShare({
      invoiceId,
      amountCents: netAmountCents,
      vendorId: app.vendor_id,
      stripeAccountId: vendorProfile.stripe_account_id,
      cutBps: 0, // computation overridden by vendorShareCents below
      overrideVendorShareCents: split.vendorShareCents,
    });
    vendorTransferId = vendorResult.transferId;

    const { data: affiliateProfile } = await admin
      .from("profiles")
      .select("stripe_account_id, charges_enabled, affiliate_active_mrr_cents")
      .eq("id", affiliateIdForTransfer)
      .single();

    if (affiliateProfile?.stripe_account_id && affiliateProfile.charges_enabled) {
      const affResult = await transferAffiliateShare({
        invoiceId,
        affiliateShareCents: split.affiliateShareCents,
        affiliateId: affiliateIdForTransfer,
        stripeAccountId: affiliateProfile.stripe_account_id,
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
          affiliate_commission_bps: affiliateCommissionSnapshotBps,
          transfer_id: affiliateTransferId,
        },
      });
      logMoneyFlow({
        action: "affiliate.transfer.created",
        entity_id: subscriptionId,
        invoice_id: invoiceId,
        amount_cents: affiliateShareCents,
        transfer_id: affiliateTransferId,
      });
    }
  } else {
    // ── Direct sale: tier-based vendor share ─────────────────────────────────
    cutBps = await getVendorCutBps(app.vendor_id);
    const result = await transferVendorShare({
      invoiceId,
      amountCents: netAmountCents,
      vendorId: app.vendor_id,
      stripeAccountId: vendorProfile.stripe_account_id,
      cutBps,
    });
    vendorTransferId = result.transferId;
    vendorShareCents = result.vendorShareCents;
  }

  // Link PaymentIntent → transfer_group so charge.refunded can find the invoice
  if (paymentIntentId) {
    await stripe.paymentIntents.update(paymentIntentId, {
      transfer_group: `invoice_${invoiceId}`,
    });
  }

  // Record revenue event for monthly tier cron (idempotent via stripe_event_id UNIQUE).
  // amount_cents = gross (drives tier thresholds). net_amount_cents = after Stripe fees (#17).
  await admin.from("vendor_revenue_events").upsert(
    {
      vendor_id: app.vendor_id,
      amount_cents: grossAmountCents,
      net_amount_cents: netAmountCents,
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
      amount_paid_gross: grossAmountCents,
      net_amount_cents: netAmountCents,
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
    amount_cents: grossAmountCents,
    net_amount_cents: netAmountCents,
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
          amountCents: grossAmountCents,
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

  // Voluntary refund: vendor absorbs the cost — only reverse the vendor transfer.
  // Affiliate and reseller markup shares are intentionally kept (SPEC §19 locked decision).
  await reverseVendorTransfers({ invoiceId, chargeId: charge.id });

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
        net_amount_cents: -refundAmountCents, // refund events: no fee adjustment available
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

  // Dispute lost: reverse ALL transfers (vendor + affiliate/reseller all absorb the loss).
  // Only act on closed+lost — created events are logged only, no reversal yet.
  if (eventType === "charge.dispute.closed" && dispute.status === "lost") {
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
  const { data: existing } = await admin
    .from("profiles")
    .select("charges_enabled")
    .eq("stripe_account_id", account.id)
    .maybeSingle();

  await admin
    .from("profiles")
    .update({
      charges_enabled: account.charges_enabled ?? false,
      payouts_enabled: account.payouts_enabled ?? false,
    })
    .eq("stripe_account_id", account.id);

  // Set weekly Friday payout schedule the first time charges become enabled
  if (account.charges_enabled && !existing?.charges_enabled) {
    const stripe = getStripe();
    await stripe.accounts.update(account.id, {
      settings: {
        payouts: {
          schedule: { interval: "weekly", weekly_anchor: "friday" },
          debit_negative_balances: true,
        },
      },
    });
  }
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
