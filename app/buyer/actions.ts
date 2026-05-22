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

export async function cancelSubscriptionAction(subscriptionId: string): Promise<CancelResult> {
  const parsed = uuidParam.safeParse(subscriptionId);
  if (!parsed.success) return { error: "Invalid subscription ID" };
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
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: true,
  });

  // Optimistic DB update — webhook will confirm
  await admin
    .from("subscriptions")
    .update({ cancel_at_period_end: true })
    .eq("id", subscriptionId);

  await admin.from("audit_log").insert({
    actor_id: user.id,
    actor_role: "buyer",
    action: "subscription.cancel_requested",
    entity_type: "subscriptions",
    entity_id: sub.stripe_subscription_id,
    metadata: { subscription_id: subscriptionId, app_id: sub.app_id } as unknown as Json,
  });

  revalidatePath("/buyer");
  return { success: true };
}

export async function pauseSubscriptionAction(
  subscriptionId: string,
  days: 30 | 60 | 90
): Promise<PauseResult> {
  const parsedId = uuidParam.safeParse(subscriptionId);
  if (!parsedId.success) return { error: "Invalid subscription ID" };
  const parsedDays = pauseDaysParam.safeParse(days);
  if (!parsedDays.success) return { error: "Invalid pause duration" };

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
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

  const resumesAt = Math.floor(Date.now() / 1000) + days * 86400;
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
    metadata: { subscription_id: subscriptionId, app_id: sub.app_id, days, paused_until: pausedUntilIso } as unknown as Json,
  });

  revalidatePath("/buyer");
  return { success: true };
}

export async function resumeSubscriptionAction(subscriptionId: string): Promise<ResumeResult> {
  const parsedId = uuidParam.safeParse(subscriptionId);
  if (!parsedId.success) return { error: "Invalid subscription ID" };

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
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
    metadata: { subscription_id: subscriptionId, app_id: sub.app_id } as unknown as Json,
  });

  revalidatePath("/buyer");
  return { success: true };
}
