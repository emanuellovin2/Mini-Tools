import { createAdminClient } from "@/lib/services/supabase";
import { formatPrice } from "@/lib/services/apps";

export type BuyerSubscription = {
  id: string;
  app_id: string;
  app_name: string;
  app_description: string | null;
  app_logo_url: string | null;
  price_cents: number;
  currency: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: string;
  canceled_at: string | null;
  paused_until: string | null;
  stripe_subscription_id: string;
  formatted_price: string;
};

export async function getBuyerSubscriptions(buyerId: string): Promise<BuyerSubscription[]> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("subscriptions")
    .select(`
      id,
      app_id,
      price_cents,
      currency,
      status,
      cancel_at_period_end,
      current_period_end,
      canceled_at,
      paused_until,
      stripe_subscription_id,
      apps!inner(name, description, logo_url)
    `)
    .eq("buyer_id", buyerId)
    .neq("status", "incomplete_expired")
    .order("created_at", { ascending: false });

  if (error) throw new Error(`getBuyerSubscriptions: ${error.message}`);

  return (data ?? []).map((row) => {
    const app = row.apps as { name: string; description: string | null; logo_url: string | null };
    return {
      id: row.id,
      app_id: row.app_id,
      app_name: app.name,
      app_description: app.description,
      app_logo_url: app.logo_url,
      price_cents: row.price_cents,
      currency: row.currency,
      status: row.status,
      cancel_at_period_end: row.cancel_at_period_end,
      current_period_end: row.current_period_end,
      canceled_at: row.canceled_at,
      paused_until: row.paused_until,
      stripe_subscription_id: row.stripe_subscription_id,
      formatted_price: formatPrice(row.price_cents, row.currency),
    };
  });
}
