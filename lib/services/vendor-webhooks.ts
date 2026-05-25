/**
 * Vendor webhook subscriber management.
 *
 * Vendors register HTTPS endpoints to receive platform events when their app's
 * subscriptions change. Payloads are HMAC-SHA256 signed (X-Platform-Signature),
 * anonymised (anon_user_id not buyer_id), and versioned (v1.* prefix).
 *
 * Dispatch is handled by the `webhook_delivery` job handler in lib/jobs/handlers.ts.
 * Auto-disable after 50 consecutive failures.
 */
import { createAdminClient } from "@/lib/services/supabase";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";
import { enqueueJob } from "@/lib/jobs/queue";
import { nanoid } from "nanoid";

type AnyClient = ReturnType<typeof createAdminClient>;

export type { V1EventType, VendorWebhook } from "./vendor-webhooks.shared";
export { V1_EVENTS } from "./vendor-webhooks.shared";

// ---------------------------------------------------------------------------
// CRUD — vendor-scoped (uses session client for RLS)
// ---------------------------------------------------------------------------

export async function listVendorWebhooks(): Promise<VendorWebhook[]> {
  const supabase = await createServerSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("vendor_webhooks")
    .select("id, vendor_id, org_id, app_id, url, events, enabled, consecutive_failures, disabled_reason, created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listVendorWebhooks: ${error.message}`);
  return data ?? [];
}

export async function createVendorWebhook(args: {
  vendorId: string;
  orgId: string;
  url: string;
  events: string[];
  appId?: string;
}): Promise<{ webhook: VendorWebhook; signingSecret: string }> {
  if (!args.url.startsWith("https://")) throw new Error("Webhook URL must use HTTPS");
  const signingSecret = nanoid(32);

  const supabase = await createServerSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("vendor_webhooks")
    .insert({
      vendor_id: args.vendorId,
      org_id: args.orgId,
      app_id: args.appId ?? null,
      url: args.url,
      signing_secret: signingSecret,
      events: args.events,
    })
    .select()
    .single();
  if (error) throw new Error(`createVendorWebhook: ${error.message}`);
  return { webhook: data, signingSecret };
}

export async function updateVendorWebhook(
  id: string,
  patch: { url?: string; events?: string[]; enabled?: boolean; appId?: string | null }
): Promise<void> {
  if (patch.url && !patch.url.startsWith("https://"))
    throw new Error("Webhook URL must use HTTPS");
  const supabase = await createServerSupabaseClient();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.url !== undefined) update.url = patch.url;
  if (patch.events !== undefined) update.events = patch.events;
  if (patch.enabled !== undefined) {
    update.enabled = patch.enabled;
    if (patch.enabled) {
      update.consecutive_failures = 0;
      update.disabled_reason = null;
    }
  }
  if (patch.appId !== undefined) update.app_id = patch.appId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("vendor_webhooks")
    .update(update)
    .eq("id", id);
  if (error) throw new Error(`updateVendorWebhook: ${error.message}`);
}

export async function rotateSigningSecret(
  id: string
): Promise<{ signingSecret: string }> {
  const signingSecret = nanoid(32);
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from("vendor_webhooks")
    .update({ signing_secret: signingSecret, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`rotateSigningSecret: ${error.message}`);
  return { signingSecret };
}

export async function deleteVendorWebhook(id: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("vendor_webhooks")
    .delete()
    .eq("id", id);
  if (error) throw new Error(`deleteVendorWebhook: ${error.message}`);
}

export async function getWebhookDeliveries(
  webhookId: string,
  limit = 50
): Promise<{ id: string; event_type: string; status_code: number | null; delivered_at: string | null; created_at: string }[]> {
  const supabase = await createServerSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("vendor_webhook_deliveries")
    .select("id, event_type, status_code, delivered_at, created_at")
    .eq("webhook_id", webhookId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Dispatch — called by webhook handlers to fan-out to registered endpoints
// ---------------------------------------------------------------------------

export async function dispatchVendorWebhookEvent(args: {
  appId: string;
  vendorId: string;
  eventType: V1EventType;
  payload: Record<string, unknown>;
}): Promise<void> {
  const admin = createAdminClient() as AnyClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type HookRow = { id: string; org_id: string | null; url: string; signing_secret: string; events: string[]; app_id: string | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: hooks } = await (admin as any)
    .from("vendor_webhooks")
    .select("id, org_id, app_id, url, signing_secret, events")
    .eq("vendor_id", args.vendorId)
    .eq("enabled", true);

  if (!hooks || hooks.length === 0) return;

  const relevantHooks = (hooks as HookRow[]).filter(
    (h) =>
      h.events.includes(args.eventType) &&
      (h.app_id === null || h.app_id === args.appId)
  );

  await Promise.allSettled(
    relevantHooks.map((hook) => {
      const deliveryId = nanoid();
      return enqueueJob(
        "webhook_delivery",
        {
          endpointUrl: hook.url,
          eventType: args.eventType,
          body: { ...args.payload, event: args.eventType },
          secret: hook.signing_secret,
          deliveryId,
          orgId: hook.org_id ?? args.vendorId,
          webhookId: hook.id,
        },
        {
          idempotencyKey: `wh:${hook.id}:${deliveryId}`,
          orgId: hook.org_id ?? undefined,
          maxAttempts: 5,
        }
      );
    })
  );
}

// ---------------------------------------------------------------------------
// Auto-disable after 50 consecutive failures
// ---------------------------------------------------------------------------

const AUTO_DISABLE_THRESHOLD = 50;

export async function recordWebhookFailure(webhookId: string): Promise<void> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: hook } = await (admin as any)
    .from("vendor_webhooks")
    .select("consecutive_failures, vendor_id")
    .eq("id", webhookId)
    .single();
  if (!hook) return;

  const failures = (hook.consecutive_failures ?? 0) + 1;
  const shouldDisable = failures >= AUTO_DISABLE_THRESHOLD;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from("vendor_webhooks")
    .update({
      consecutive_failures: failures,
      enabled: shouldDisable ? false : true,
      disabled_reason: shouldDisable
        ? `Auto-disabled after ${AUTO_DISABLE_THRESHOLD} consecutive failures`
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", webhookId);

  if (shouldDisable) {
    const { createNotification } = await import("@/lib/services/notifications");
    await createNotification({
      userId: hook.vendor_id,
      type: "webhook_failures",
      title: "Webhook endpoint auto-disabled",
      body: `An endpoint reached ${AUTO_DISABLE_THRESHOLD} consecutive failures and has been disabled.`,
      link: "/vendor/settings/webhooks",
    }).catch(() => {});
  }
}

export async function recordWebhookSuccess(webhookId: string): Promise<void> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from("vendor_webhooks")
    .update({ consecutive_failures: 0, updated_at: new Date().toISOString() })
    .eq("id", webhookId)
    .gt("consecutive_failures", 0);
}
