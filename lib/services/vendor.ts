import { createAdminClient } from "./supabase";
import { createServerSupabaseClient } from "./supabase-server";
import type { Database } from "@/types/supabase";

export type VendorApp = Database["public"]["Tables"]["apps"]["Row"];

export type VendorSubscriptionStat = {
  app_id: string;
  anon_user_id: string;
  status: string;
  price_cents: number;
  current_period_end: string;
};

export async function getVendorApps(vendorId: string): Promise<VendorApp[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("apps")
    .select("*")
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getVendorStats(): Promise<VendorSubscriptionStat[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("vendor_subscription_stats");
  if (error) throw error;
  return (data ?? []) as VendorSubscriptionStat[];
}

// Aggregate MRR and active subscriber count per app from stats (no buyer identity)
export function aggregateStats(
  appId: string,
  stats: VendorSubscriptionStat[]
): { activeCount: number; mrrCents: number } {
  const active = stats.filter(
    (s) =>
      s.app_id === appId &&
      (s.status === "active" || s.status === "trialing")
  );
  return {
    activeCount: active.length,
    mrrCents: active.reduce((sum, s) => sum + s.price_cents, 0),
  };
}
