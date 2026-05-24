import { createAdminClient } from "@/lib/services/supabase";
import { createServerSupabaseClient } from "@/lib/services/supabase-server";

export type NotificationType =
  | "renewal_failed"
  | "payout_sent"
  | "app_approved"
  | "app_rejected"
  | "churn_alert"
  | "dispute_opened"
  | "dispute_lost"
  | "large_refund"
  | "floor_change"
  | "wl_trial_ending"
  | "badge_earned"
  | "tier_upgraded"
  | "large_clawback"
  | "reconciliation_drift"
  | "webhook_failures"
  | "metric_cardinality_overflow";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Write path (service-role only — called from webhook handlers / crons)
// ---------------------------------------------------------------------------

export async function createNotification(args: {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
}): Promise<void> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any).from("notifications").insert({
    user_id: args.userId,
    type: args.type,
    title: args.title,
    body: args.body ?? null,
    link: args.link ?? null,
  });
  if (error) throw new Error(`createNotification: ${error.message}`);
}

// Fan-out: create the same notification for multiple users
export async function createNotificationBatch(
  userIds: string[],
  args: {
    type: NotificationType;
    title: string;
    body?: string;
    link?: string;
  }
): Promise<void> {
  if (userIds.length === 0) return;
  const admin = createAdminClient();
  const rows = userIds.map((uid) => ({
    user_id: uid,
    type: args.type,
    title: args.title,
    body: args.body ?? null,
    link: args.link ?? null,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any).from("notifications").insert(rows);
  if (error) throw new Error(`createNotificationBatch: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Read path (user-scoped — uses session client)
// ---------------------------------------------------------------------------

export async function getUserNotifications(limit = 20): Promise<AppNotification[]> {
  const supabase = await createServerSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("notifications")
    .select("id, type, title, body, link, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getUserNotifications: ${error.message}`);
  return (data ?? []).map((n: { id: string; type: NotificationType; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    read: n.read_at !== null,
    created_at: n.created_at,
  }));
}

export async function getUnreadCount(): Promise<number> {
  const supabase = await createServerSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count, error } = await (supabase as any)
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);
  if (error) return 0;
  return count ?? 0;
}

export async function markNotificationRead(id: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);
  if (error) throw new Error(`markNotificationRead: ${error.message}`);
}

export async function markAllRead(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);
  if (error) throw new Error(`markAllRead: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export interface NotificationPreference {
  notif_type: string;
  in_app_enabled: boolean;
  email_enabled: boolean;
  frequency: "immediate" | "daily" | "weekly";
}

export async function getNotificationPreferences(): Promise<NotificationPreference[]> {
  const supabase = await createServerSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("notification_preferences")
    .select("notif_type, in_app_enabled, email_enabled, frequency");
  if (error) throw new Error(`getNotificationPreferences: ${error.message}`);
  return data ?? [];
}

export async function upsertNotificationPreference(
  pref: Omit<NotificationPreference, never> & { userId: string }
): Promise<void> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any).from("notification_preferences").upsert(
    {
      user_id: pref.userId,
      notif_type: pref.notif_type,
      in_app_enabled: pref.in_app_enabled,
      email_enabled: pref.email_enabled,
      frequency: pref.frequency,
    },
    { onConflict: "user_id,notif_type" }
  );
  if (error) throw new Error(`upsertNotificationPreference: ${error.message}`);
}

// Default preferences for all known notification types
export const NOTIFICATION_TYPES: Array<{
  type: NotificationType;
  label: string;
  roles: string[];
  defaultEmailEnabled: boolean;
}> = [
  { type: "renewal_failed",       label: "Payment renewal failed",      roles: ["buyer"],                          defaultEmailEnabled: true },
  { type: "payout_sent",          label: "Payout sent",                  roles: ["vendor", "affiliate", "reseller"], defaultEmailEnabled: true },
  { type: "app_approved",         label: "App approved by admin",        roles: ["vendor"],                         defaultEmailEnabled: true },
  { type: "app_rejected",         label: "App rejected by admin",        roles: ["vendor"],                         defaultEmailEnabled: true },
  { type: "churn_alert",          label: "Churn rate alert",             roles: ["vendor"],                         defaultEmailEnabled: true },
  { type: "dispute_opened",       label: "Dispute / chargeback opened",  roles: ["vendor"],                         defaultEmailEnabled: true },
  { type: "dispute_lost",         label: "Dispute lost",                 roles: ["vendor"],                         defaultEmailEnabled: true },
  { type: "large_refund",         label: "Large refund issued",          roles: ["vendor", "reseller"],             defaultEmailEnabled: false },
  { type: "floor_change",         label: "Vendor changed price floor",   roles: ["reseller"],                       defaultEmailEnabled: true },
  { type: "wl_trial_ending",      label: "White-label trial ending soon", roles: ["reseller"],                      defaultEmailEnabled: true },
  { type: "badge_earned",         label: "New badge earned",             roles: ["affiliate"],                      defaultEmailEnabled: false },
  { type: "tier_upgraded",        label: "Affiliate tier upgraded",      roles: ["affiliate"],                      defaultEmailEnabled: true },
  { type: "large_clawback",       label: "Large refund clawback",        roles: ["affiliate"],                      defaultEmailEnabled: true },
  { type: "reconciliation_drift", label: "Reconciliation drift detected", roles: ["admin"],                         defaultEmailEnabled: true },
  { type: "webhook_failures",     label: "Webhook failure spike",        roles: ["admin"],                          defaultEmailEnabled: true },
];
