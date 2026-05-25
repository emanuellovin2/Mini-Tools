export const V1_EVENTS = [
  "v1.subscription.created",
  "v1.subscription.updated",
  "v1.subscription.canceled",
  "v1.subscription.paused",
  "v1.subscription.resumed",
  "v1.payment.failed",
  "v1.refund.created",
] as const;

export type V1EventType = (typeof V1_EVENTS)[number];

export interface VendorWebhook {
  id: string;
  vendor_id: string;
  org_id: string | null;
  app_id: string | null;
  url: string;
  events: string[];
  enabled: boolean;
  consecutive_failures: number;
  disabled_reason: string | null;
  created_at: string;
}
