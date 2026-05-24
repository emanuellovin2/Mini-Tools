import Stripe from "stripe";
import { createAdminClient } from "@/lib/services/supabase";
import { enqueueJob } from "@/lib/jobs/queue";
import { getStripe } from "@/lib/stripe/client";
import { withStripeRetry } from "@/lib/stripe/with-retry";
import { priceUnit, computeUsageSplit } from "@/lib/usage/split";
import type { PricingConfig } from "@/lib/usage/split";

// Not yet in generated DB types — cast until `npm run types` runs after migration
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageMeter {
  id: string;
  owner_org_id: string;
  product_type: "gateway" | "workflow" | "connector" | "custom";
  unit: string;
  currency: string;
  pricing: PricingConfig;
  cost_mode: "byok" | "managed";
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateMeterArgs {
  ownerOrgId: string;
  productType: UsageMeter["product_type"];
  unit: string;
  pricing: PricingConfig;
  costMode?: "byok" | "managed";
}

export interface RecordUsageArgs {
  meterId: string;
  buyerId: string;
  quantity: number;
  idempotencyKey?: string;
  /** ISO timestamp of when the usage occurred; defaults to now(). */
  occurredAt?: string;
  /**
   * Cumulative units already consumed this period — used by priceUnit for
   * tiered/volume pricing. Defaults to 0.
   */
  cumulativeQty?: number;
  /** For managed mode: actual provider cost per unit reported by the provider. */
  providerCostCentsPerUnit?: number;
  /** Actor org for audit_log. */
  actorOrgId?: string;
}

export interface RecordUsageResult {
  ok: boolean;
  deduped: boolean;
  blocked: boolean;
  remainingBalanceCents: number;
  eventId: string | null;
}

// ---------------------------------------------------------------------------
// Meter management
// ---------------------------------------------------------------------------

export async function createMeter(args: CreateMeterArgs): Promise<UsageMeter> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("usage_meters")
    .insert({
      owner_org_id: args.ownerOrgId,
      product_type: args.productType,
      unit: args.unit,
      pricing: args.pricing,
      cost_mode: args.costMode ?? "byok",
    })
    .select()
    .single();
  if (error) throw new Error(`createMeter: ${error.message}`);
  return data as UsageMeter;
}

export async function getMeter(meterId: string): Promise<UsageMeter | null> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("usage_meters")
    .select("*")
    .eq("id", meterId)
    .maybeSingle();
  if (error) throw new Error(`getMeter: ${error.message}`);
  return data as UsageMeter | null;
}

// ---------------------------------------------------------------------------
// Core metering: recordUsage
// ---------------------------------------------------------------------------

export async function recordUsage(args: RecordUsageArgs): Promise<RecordUsageResult> {
  const admin = createAdminClient() as AnyAdmin;
  const {
    meterId,
    buyerId,
    quantity,
    idempotencyKey,
    occurredAt,
    cumulativeQty = 0,
    providerCostCentsPerUnit = 0,
    actorOrgId,
  } = args;

  // 1. Fetch meter + subscription attribution
  const { data: meter, error: meterErr } = await admin
    .from("usage_meters")
    .select("*")
    .eq("id", meterId)
    .eq("active", true)
    .maybeSingle();

  if (meterErr) throw new Error(`recordUsage: meter fetch failed: ${meterErr.message}`);
  if (!meter) throw new Error(`recordUsage: meter ${meterId} not found or inactive`);

  // 2. Attribution: look for an active subscription linking this buyer to this meter's vendor
  //    Subscription carries affiliate_id / reseller_id snapshot.
  const { data: sub } = await admin
    .from("subscriptions")
    .select(
      "id, affiliate_id, reseller_id, affiliate_commission_snapshot_bps, vendor_floor_snapshot_cents"
    )
    .eq("buyer_id", buyerId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  // 3. Compute pricing splits
  const { vendorCents: rawVendorPerUnit, platformCents: rawPlatformPerUnit } =
    priceUnit(meter.pricing as PricingConfig, cumulativeQty, quantity);

  // Determine reseller markup per unit if reseller-attributed
  const resellerMarkupCentsPerUnit =
    sub?.reseller_id != null && sub.vendor_floor_snapshot_cents != null
      ? undefined // markup comes from the subscription price; passed as 0 here since we bill separately for now
      : undefined;

  const billableCents =
    (rawVendorPerUnit + rawPlatformPerUnit) + // vendor + platform
    (resellerMarkupCentsPerUnit != null ? resellerMarkupCentsPerUnit * quantity : 0);

  const split = computeUsageSplit({
    billableCents,
    vendorUnitPriceCents: rawVendorPerUnit / quantity,
    platformFeeCents: rawPlatformPerUnit / quantity,
    qty: quantity,
    resellerMarkupCentsPerUnit,
    affiliateCommissionBps: sub?.affiliate_commission_snapshot_bps ?? undefined,
    costMode: meter.cost_mode,
    providerCostCentsPerUnit:
      meter.cost_mode === "managed" ? providerCostCentsPerUnit : undefined,
  });

  // 4. Call record_usage RPC (atomic: lock + insert + draw-down + audit)
  const { data: result, error: rpcErr } = await admin.rpc("record_usage", {
    p_meter_id: meterId,
    p_buyer_id: buyerId,
    p_subscription_id: sub?.id ?? null,
    p_quantity: quantity,
    p_provider_cost_cents: providerCostCentsPerUnit * quantity,
    p_billable_cents: split.billableCents,
    p_vendor_share_cents: split.vendorCents,
    p_platform_share_cents: split.platformCents,
    p_reseller_share_cents: split.resellerCents,
    p_affiliate_share_cents: split.affiliateCents,
    p_idempotency_key: idempotencyKey ?? null,
    p_occurred_at: occurredAt ?? new Date().toISOString(),
    p_actor_org_id: actorOrgId ?? null,
  });

  if (rpcErr) throw new Error(`recordUsage: RPC failed: ${rpcErr.message}`);

  const r = result as {
    ok: boolean;
    deduped: boolean;
    blocked: boolean;
    remaining_balance_cents: number;
    event_id: string | null;
  };

  return {
    ok: r.ok,
    deduped: r.deduped,
    blocked: r.blocked,
    remainingBalanceCents: r.remaining_balance_cents,
    eventId: r.event_id,
  };
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export async function getUsageBalance(buyerId: string): Promise<{ balanceCents: number }> {
  const admin = createAdminClient() as AnyAdmin;
  const { data, error } = await admin
    .from("credit_wallets")
    .select("balance_cents")
    .eq("buyer_id", buyerId)
    .maybeSingle();
  if (error) throw new Error(`getUsageBalance: ${error.message}`);
  return { balanceCents: (data?.balance_cents as number | null) ?? 0 };
}

/**
 * Create a Stripe Checkout session for topping up credits.
 * The webhook handler (payment_intent.succeeded) calls topup_credits RPC to credit the wallet.
 */
export async function topUpCredits(
  buyerId: string,
  amountCents: number,
  successUrl: string,
  cancelUrl: string
): Promise<{ checkoutUrl: string }> {
  if (amountCents < 100) throw new Error("topUpCredits: minimum top-up is $1.00");

  const stripe = getStripe();
  const admin = createAdminClient() as AnyAdmin;

  // Ensure Stripe customer
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_customer_id, email")
    .eq("id", buyerId)
    .maybeSingle();

  const session = await withStripeRetry(() =>
    stripe.checkout.sessions.create({
      mode: "payment",
      customer: profile?.stripe_customer_id ?? undefined,
      customer_email: profile?.stripe_customer_id ? undefined : profile?.email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Platform Credits" },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        metadata: {
          type: "credit_topup",
          buyer_id: buyerId,
          amount_cents: amountCents.toString(),
        },
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    })
  );

  if (!session.url) throw new Error("topUpCredits: Stripe did not return a checkout URL");
  return { checkoutUrl: session.url };
}

// ---------------------------------------------------------------------------
// Usage revenue (for vendor/reseller/affiliate dashboards)
// ---------------------------------------------------------------------------

export async function getUsageRevenue(
  ownerOrgId: string,
  days = 30
): Promise<{ byMeter: Array<{ meterId: string; totalCents: number }>; totalCents: number }> {
  const admin = createAdminClient() as AnyAdmin;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: meters, error: mErr } = await admin
    .from("usage_meters")
    .select("id")
    .eq("owner_org_id", ownerOrgId);
  if (mErr) throw new Error(`getUsageRevenue: ${mErr.message}`);

  const meterIds: string[] = (meters ?? []).map((m: { id: string }) => m.id);
  if (meterIds.length === 0) return { byMeter: [], totalCents: 0 };

  const { data: events, error: eErr } = await admin
    .from("usage_events")
    .select("meter_id, vendor_share_cents")
    .in("meter_id", meterIds)
    .gte("created_at", since);
  if (eErr) throw new Error(`getUsageRevenue: ${eErr.message}`);

  const grouped: Record<string, number> = {};
  for (const ev of events ?? []) {
    grouped[ev.meter_id] = (grouped[ev.meter_id] ?? 0) + (ev.vendor_share_cents as number);
  }

  const byMeter = Object.entries(grouped).map(([meterId, totalCents]) => ({
    meterId,
    totalCents,
  }));
  const totalCents = byMeter.reduce((s, r) => s + r.totalCents, 0);
  return { byMeter, totalCents };
}

// ---------------------------------------------------------------------------
// Settlement (called by the settlement job handler)
// ---------------------------------------------------------------------------

export interface SettleUsageArgs {
  vendorOrgId: string;
  vendorStripeAccountId: string;
  batchId: string;
  batchWindowEnd: string; // ISO timestamp: only settle events before this
}

export async function settleUsageBatch(args: SettleUsageArgs): Promise<{
  transfersCreated: number;
  totalCents: number;
}> {
  const { vendorOrgId, vendorStripeAccountId, batchId, batchWindowEnd } = args;
  const admin = createAdminClient() as AnyAdmin;
  const stripe = getStripe();

  // 1. Fetch all meters owned by this vendor org
  const { data: meters, error: mErr } = await admin
    .from("usage_meters")
    .select("id")
    .eq("owner_org_id", vendorOrgId);
  if (mErr) throw new Error(`settleUsageBatch: meter fetch: ${mErr.message}`);

  const meterIds: string[] = (meters ?? []).map((m: { id: string }) => m.id);
  if (meterIds.length === 0) return { transfersCreated: 0, totalCents: 0 };

  // 2. Aggregate unsettled vendor shares for these meters up to the batch window
  const { data: events, error: eErr } = await admin
    .from("usage_events")
    .select("id, vendor_share_cents, reseller_share_cents, affiliate_share_cents, subscription_id")
    .in("meter_id", meterIds)
    .is("settled_at", null)
    .lt("created_at", batchWindowEnd);
  if (eErr) throw new Error(`settleUsageBatch: events fetch: ${eErr.message}`);

  if (!events || events.length === 0) return { transfersCreated: 0, totalCents: 0 };

  const totalVendorCents = (events as Array<{ vendor_share_cents: number }>).reduce(
    (s, e) => s + e.vendor_share_cents,
    0
  );

  let transfersCreated = 0;

  // 3. Single transfer to vendor for the whole batch (idempotent re-run safe)
  if (totalVendorCents > 0) {
    await withStripeRetry(() =>
      stripe.transfers.create(
        {
          amount: totalVendorCents,
          currency: "usd",
          destination: vendorStripeAccountId,
          transfer_group: `usage:${vendorOrgId}:${batchId}`,
          metadata: {
            batch_id: batchId,
            vendor_org_id: vendorOrgId,
            event_count: events.length.toString(),
            type: "usage_vendor_share",
          },
        },
        { idempotencyKey: `usage_transfer:${batchId}:vendor:${vendorOrgId}` }
      )
    );
    transfersCreated++;
  }

  // 4. Mark events settled
  const eventIds = events.map((e: { id: string }) => e.id);
  const { error: updateErr } = await admin
    .from("usage_events")
    .update({ settled_at: new Date().toISOString() })
    .in("id", eventIds);
  if (updateErr) throw new Error(`settleUsageBatch: mark settled: ${updateErr.message}`);

  // 5. Audit
  await admin.from("audit_log").insert({
    actor_id: null,
    actor_org_id: vendorOrgId,
    action: "usage.settled",
    resource_type: "settlement_batch",
    resource_id: batchId,
    metadata: {
      batch_id: batchId,
      event_count: events.length,
      vendor_transfer_cents: totalVendorCents,
      transfers_created: transfersCreated,
    },
  });

  return { transfersCreated, totalCents: totalVendorCents };
}

/**
 * Enqueue settlement jobs for all vendor orgs with unsettled usage events.
 * Called by usage-settlement-cron (daily).
 */
export async function enqueueSettlementJobs(): Promise<{ jobsEnqueued: number }> {
  const admin = createAdminClient() as AnyAdmin;
  const batchWindowEnd = new Date().toISOString();
  const batchDate = new Date().toISOString().slice(0, 10);

  // Find distinct vendor orgs with unsettled events
  const { data: meters, error } = await admin
    .from("usage_meters")
    .select("id, owner_org_id");
  if (error) throw new Error(`enqueueSettlementJobs: ${error.message}`);

  const orgIds: string[] = [
    ...new Set(
      (meters as Array<{ owner_org_id: string }> ?? []).map((m) => m.owner_org_id)
    ),
  ];

  let jobsEnqueued = 0;
  for (const orgId of orgIds) {
    // Fetch Stripe account for this org
    const { data: org } = await admin
      .from("organizations")
      .select("stripe_account_id")
      .eq("id", orgId)
      .maybeSingle();

    if (!org?.stripe_account_id) continue;

    const batchId = `${orgId}:${batchDate}`;
    await enqueueJob(
      "settlement",
      {
        vendorOrgId: orgId,
        vendorStripeAccountId: org.stripe_account_id,
        batchId,
        batchWindowEnd,
      },
      {
        idempotencyKey: `settlement:${batchId}`,
        orgId,
      }
    );
    jobsEnqueued++;
  }

  return { jobsEnqueued };
}
