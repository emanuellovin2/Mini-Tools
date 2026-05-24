"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { createAdminClient } from "@/lib/services/supabase";
import { getStripe } from "@/lib/stripe/client";
import type { Json } from "@/types/supabase";

const uuidParam = z.string().uuid("Invalid subscription ID");
const pauseDaysParam = z.union([z.literal(30), z.literal(60), z.literal(90)]);

export type CancelResult = { success: true } | { error: string };
export type PauseResult = { success: true } | { error: string };
export type ResumeResult = { success: true } | { error: string };
export type SetupResult = { clientSecret: string } | { error: string };
export type PMResult = { success: true } | { error: string };

// ---------------------------------------------------------------------------
// cancelSubscriptionAction — now accepts optional reason for #35
// ---------------------------------------------------------------------------

const cancelSchema = z.object({
  subscriptionId: z.string().uuid(),
  reasonCode: z
    .enum([
      "too_expensive",
      "not_using",
      "switched_product",
      "missing_feature",
      "bug_or_quality",
      "other",
    ])
    .optional(),
  comment: z.string().max(500).optional(),
  immediate: z.boolean().default(false),
});

export async function cancelSubscriptionAction(
  input: string | z.infer<typeof cancelSchema>
): Promise<CancelResult> {
  // Accept both legacy string call and new object form
  const parsed = cancelSchema.safeParse(
    typeof input === "string" ? { subscriptionId: input } : input
  );
  if (!parsed.success) return { error: "Invalid input." };
  const { subscriptionId, reasonCode, comment, immediate } = parsed.data;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, buyer_id, stripe_subscription_id, status, app_id")
    .eq("id", subscriptionId)
    .single();

  if (!sub) return { error: "Subscription not found" };
  if (sub.buyer_id !== user.id) return { error: "Unauthorized" };
  if (!["active", "trialing"].includes(sub.status)) {
    return { error: "Only active subscriptions can be cancelled" };
  }

  const stripe = getStripe();

  if (immediate) {
    await stripe.subscriptions.cancel(sub.stripe_subscription_id);
  } else {
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
    await admin
      .from("subscriptions")
      .update({ cancel_at_period_end: true })
      .eq("id", subscriptionId);
  }

  // Record cancel reason if provided
  if (reasonCode) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin.from as any)("subscription_cancel_reasons").insert({
      subscription_id: subscriptionId,
      buyer_id: user.id,
      app_id: sub.app_id,
      reason_code: reasonCode,
      comment: comment ?? null,
    });
  }

  await admin.from("audit_log").insert({
    actor_id: user.id,
    actor_role: "buyer",
    action: immediate ? "subscription.canceled" : "subscription.cancel_requested",
    entity_type: "subscriptions",
    entity_id: sub.stripe_subscription_id,
    metadata: {
      subscription_id: subscriptionId,
      app_id: sub.app_id,
      reason_code: reasonCode ?? null,
      immediate,
    } as unknown as Json,
  });

  revalidatePath("/buyer");
  return { success: true };
}

// ---------------------------------------------------------------------------
// pauseSubscriptionAction — now accepts an ISO date string (≤90 days)
// ---------------------------------------------------------------------------

export async function pauseSubscriptionAction(
  subscriptionId: string,
  daysOrDate: 30 | 60 | 90 | string
): Promise<PauseResult> {
  const parsedId = uuidParam.safeParse(subscriptionId);
  if (!parsedId.success) return { error: "Invalid subscription ID" };

  let resumesAt: number;

  if (typeof daysOrDate === "number") {
    const parsedDays = pauseDaysParam.safeParse(daysOrDate);
    if (!parsedDays.success) return { error: "Invalid pause duration" };
    resumesAt = Math.floor(Date.now() / 1000) + daysOrDate * 86400;
  } else {
    // ISO date string
    const date = new Date(daysOrDate);
    if (isNaN(date.getTime())) return { error: "Invalid date" };
    const diffDays = (date.getTime() - Date.now()) / 86_400_000;
    if (diffDays < 1) return { error: "Pause date must be in the future" };
    if (diffDays > 90) return { error: "Cannot pause more than 90 days" };
    resumesAt = Math.floor(date.getTime() / 1000);
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, buyer_id, stripe_subscription_id, status, app_id, paused_until")
    .eq("id", subscriptionId)
    .single();

  if (!sub) return { error: "Subscription not found" };
  if (sub.buyer_id !== user.id) return { error: "Unauthorized" };
  if (!["active", "trialing"].includes(sub.status)) {
    return { error: "Only active subscriptions can be paused" };
  }
  if (sub.paused_until && new Date(sub.paused_until) > new Date()) {
    return { error: "Subscription is already paused" };
  }

  const stripe = getStripe();
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    pause_collection: { behavior: "void", resumes_at: resumesAt },
  });

  const pausedUntilIso = new Date(resumesAt * 1000).toISOString();
  await admin
    .from("subscriptions")
    .update({
      paused_until: pausedUntilIso,
      pause_started_at: new Date().toISOString(),
    })
    .eq("id", subscriptionId);

  await admin.from("audit_log").insert({
    actor_id: user.id,
    actor_role: "buyer",
    action: "subscription.paused",
    entity_type: "subscriptions",
    entity_id: sub.stripe_subscription_id,
    metadata: {
      subscription_id: subscriptionId,
      app_id: sub.app_id,
      paused_until: pausedUntilIso,
    } as unknown as Json,
  });

  revalidatePath("/buyer");
  return { success: true };
}

// ---------------------------------------------------------------------------
// resumeSubscriptionAction (unchanged)
// ---------------------------------------------------------------------------

export async function resumeSubscriptionAction(
  subscriptionId: string
): Promise<ResumeResult> {
  const parsedId = uuidParam.safeParse(subscriptionId);
  if (!parsedId.success) return { error: "Invalid subscription ID" };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, buyer_id, stripe_subscription_id, status, app_id, paused_until")
    .eq("id", subscriptionId)
    .single();

  if (!sub) return { error: "Subscription not found" };
  if (sub.buyer_id !== user.id) return { error: "Unauthorized" };
  if (!sub.paused_until || new Date(sub.paused_until) <= new Date()) {
    return { error: "Subscription is not currently paused" };
  }

  const stripe = getStripe();
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    pause_collection: "",
  } as Parameters<typeof stripe.subscriptions.update>[1]);

  await admin
    .from("subscriptions")
    .update({ paused_until: null })
    .eq("id", subscriptionId);

  await admin.from("audit_log").insert({
    actor_id: user.id,
    actor_role: "buyer",
    action: "subscription.resumed",
    entity_type: "subscriptions",
    entity_id: sub.stripe_subscription_id,
    metadata: {
      subscription_id: subscriptionId,
      app_id: sub.app_id,
    } as unknown as Json,
  });

  revalidatePath("/buyer");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Payment method management
// ---------------------------------------------------------------------------

export async function createSetupIntentAction(): Promise<SetupResult> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("buyer_id", user.id)
    .in("status", ["active", "trialing"])
    .limit(1)
    .maybeSingle();

  if (!sub?.stripe_customer_id) {
    return { error: "No active subscription found to attach a payment method to." };
  }

  const stripe = getStripe();
  const setupIntent = await stripe.setupIntents.create({
    customer: sub.stripe_customer_id,
    usage: "off_session",
    payment_method_types: ["card"],
  });

  if (!setupIntent.client_secret) return { error: "Failed to create setup intent." };
  return { clientSecret: setupIntent.client_secret };
}

export async function setDefaultPaymentMethodAction(pmId: string): Promise<PMResult> {
  if (!pmId.startsWith("pm_")) return { error: "Invalid payment method ID." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("buyer_id", user.id)
    .in("status", ["active", "trialing"])
    .limit(1)
    .maybeSingle();

  if (!sub?.stripe_customer_id) return { error: "No active subscription found." };

  const stripe = getStripe();

  // Verify PM belongs to this customer before setting default
  const pm = await stripe.paymentMethods.retrieve(pmId);
  if (pm.customer !== sub.stripe_customer_id) return { error: "Payment method not found." };

  await stripe.customers.update(sub.stripe_customer_id, {
    invoice_settings: { default_payment_method: pmId },
  });

  revalidatePath("/buyer");
  return { success: true };
}

export async function detachPaymentMethodAction(pmId: string): Promise<PMResult> {
  if (!pmId.startsWith("pm_")) return { error: "Invalid payment method ID." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" };

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("buyer_id", user.id)
    .in("status", ["active", "trialing"])
    .limit(1)
    .maybeSingle();

  if (!sub?.stripe_customer_id) return { error: "No active subscription found." };

  const stripe = getStripe();

  // Verify PM belongs to this customer before detaching
  const pm = await stripe.paymentMethods.retrieve(pmId);
  if (pm.customer !== sub.stripe_customer_id) return { error: "Payment method not found." };

  await stripe.paymentMethods.detach(pmId);

  revalidatePath("/buyer");
  return { success: true };
}
