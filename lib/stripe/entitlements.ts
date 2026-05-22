import type { Database } from "@/types/supabase";

export type SubscriptionStatus = Database["public"]["Enums"]["subscription_status"];

const VALID_STRIPE_STATUSES = new Set([
  "incomplete", "incomplete_expired", "active", "trialing",
  "past_due", "unpaid", "canceled", "paused",
]);

// Maps a raw Stripe status string to our DB enum — throws on unknown values.
// Never silently default; callers must handle the error (logged to audit_log in prod).
export function stripeStatusToSubscriptionStatus(stripeStatus: string): SubscriptionStatus {
  if (VALID_STRIPE_STATUSES.has(stripeStatus)) return stripeStatus as SubscriptionStatus;
  throw new Error(`Unknown Stripe subscription status: "${stripeStatus}"`);
}

// Access check that also accounts for Stripe pause_collection (#23).
// Stripe keeps status='active' while paused — paused_until is the authoritative flag.
export function isAccessActive(sub: {
  status: SubscriptionStatus;
  paused_until: string | null;
}): boolean {
  if (sub.paused_until && new Date(sub.paused_until) > new Date()) return false;
  return subscriptionStatusToAccess(sub.status);
}

// Single source of truth for access — used by the webhook handler AND /api/verify (#8).
// Throws (not returns false) on unhandled statuses so the caller surfaces the bug.
export function subscriptionStatusToAccess(status: SubscriptionStatus): boolean {
  switch (status) {
    case "active":
    case "trialing":
      return true;
    case "incomplete":
    case "incomplete_expired":
    case "past_due":
    case "unpaid":
    case "paused":
    case "canceled":
      return false;
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled subscription status: "${_exhaustive}"`);
    }
  }
}
