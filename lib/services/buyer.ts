import { createAdminClient } from "@/lib/services/supabase";
import { formatPrice } from "@/lib/services/apps";
import { getStripe } from "@/lib/stripe/client";

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
  stripe_customer_id: string;
  formatted_price: string;
  created_at: string;
  affiliate_id: string | null;
  reseller_id: string | null;
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
      stripe_customer_id,
      created_at,
      affiliate_id,
      reseller_id,
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
      stripe_customer_id: row.stripe_customer_id,
      formatted_price: formatPrice(row.price_cents, row.currency),
      created_at: row.created_at,
      affiliate_id: row.affiliate_id,
      reseller_id: row.reseller_id,
    };
  });
}

// ---------------------------------------------------------------------------
// Upcoming charges (next 30 days) — from Supabase RPC (no Stripe call)
// ---------------------------------------------------------------------------

export type UpcomingCharge = {
  subscription_id: string;
  app_name: string;
  app_logo_url: string | null;
  price_cents: number;
  currency: string;
  next_charge_at: string;
};

export async function getBuyerUpcomingCharges(buyerId: string): Promise<UpcomingCharge[]> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin.rpc as any)("get_buyer_upcoming_charges", {
    p_buyer_id: buyerId,
  });
  if (error) throw new Error(`getBuyerUpcomingCharges: ${error.message}`);
  return (data ?? []) as UpcomingCharge[];
}

// ---------------------------------------------------------------------------
// Payment methods (Stripe)
// ---------------------------------------------------------------------------

export type BuyerPaymentMethod = {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
};

export async function getBuyerPaymentMethods(
  stripeCustomerId: string
): Promise<BuyerPaymentMethod[]> {
  const stripe = getStripe();

  const [customer, pms] = await Promise.all([
    stripe.customers.retrieve(stripeCustomerId),
    stripe.paymentMethods.list({ customer: stripeCustomerId, type: "card" }),
  ]);

  if (customer.deleted) return [];

  const defaultPmId =
    typeof customer.invoice_settings?.default_payment_method === "string"
      ? customer.invoice_settings.default_payment_method
      : null;

  return pms.data
    .filter((pm) => pm.card)
    .map((pm) => ({
      id: pm.id,
      brand: pm.card!.brand,
      last4: pm.card!.last4,
      exp_month: pm.card!.exp_month,
      exp_year: pm.card!.exp_year,
      is_default: pm.id === defaultPmId,
    }));
}

// ---------------------------------------------------------------------------
// Invoices (Stripe, paginated)
// ---------------------------------------------------------------------------

export type BuyerInvoice = {
  id: string;
  subscription_id: string | null;
  app_name: string | null;
  amount_paid: number;
  currency: string;
  status: string;
  created: number;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
};

export async function getBuyerInvoices(
  stripeCustomerId: string,
  { limit = 20, starting_after }: { limit?: number; starting_after?: string } = {}
): Promise<{ invoices: BuyerInvoice[]; hasMore: boolean }> {
  const stripe = getStripe();

  const params: Parameters<typeof stripe.invoices.list>[0] = {
    customer: stripeCustomerId,
    limit,
    expand: ["data.subscription"],
  };
  if (starting_after) params.starting_after = starting_after;

  const result = await stripe.invoices.list(params);

  const invoices: BuyerInvoice[] = result.data.map((inv) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyInv = inv as any;
    const sub =
      typeof anyInv.subscription === "object" && anyInv.subscription
        ? anyInv.subscription
        : null;
    const appName = sub?.metadata?.app_name ?? null;

    return {
      id: inv.id,
      subscription_id:
        typeof anyInv.subscription === "string"
          ? anyInv.subscription
          : (sub?.id ?? null),
      app_name: appName,
      amount_paid: inv.amount_paid,
      currency: inv.currency,
      status: inv.status ?? "unknown",
      created: inv.created,
      hosted_invoice_url: inv.hosted_invoice_url ?? null,
      invoice_pdf: inv.invoice_pdf ?? null,
    };
  });

  return { invoices, hasMore: result.has_more };
}

// ---------------------------------------------------------------------------
// Spend history (last N months from RPC)
// ---------------------------------------------------------------------------

export type SpendMonth = { month: string; total_cents: number };

export async function getBuyerSpendHistory(
  buyerId: string,
  months = 6
): Promise<SpendMonth[]> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin.rpc as any)("get_buyer_spend_history", {
    p_buyer_id: buyerId,
    p_months: months,
  });
  if (error) throw new Error(`getBuyerSpendHistory: ${error.message}`);
  return (data ?? []).map((r: { month: string; total_cents: string | number }) => ({
    month: r.month,
    total_cents: Number(r.total_cents),
  }));
}

// ---------------------------------------------------------------------------
// Recommendations — apps from same categories as buyer's active subs
// ---------------------------------------------------------------------------

export type RecommendedApp = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price_cents: number;
  currency: string;
  screenshot_urls: string[];
  rating_avg: number;
};

export async function getBuyerRecommendations(
  buyerId: string,
  limit = 3
): Promise<RecommendedApp[]> {
  const admin = createAdminClient();

  // Get buyer's active sub categories
  const { data: subs } = await admin
    .from("subscriptions")
    .select("app_id, apps!inner(category)")
    .eq("buyer_id", buyerId)
    .in("status", ["active", "trialing"]);

  const subscribedAppIds = (subs ?? []).map((s) => s.app_id);
  const categories = [
    ...new Set(
      (subs ?? [])
        .map((s) => (s.apps as { category: string | null }).category)
        .filter((c): c is string => !!c)
    ),
  ];

  if (categories.length === 0) return [];

  const { data } = await admin
    .from("apps")
    .select("id, name, description, category, price_cents, currency, screenshot_urls")
    .eq("status", "approved")
    .in("category", categories)
    .not("id", "in", `(${subscribedAppIds.join(",")})`)
    .limit(limit);

  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    price_cents: r.price_cents,
    currency: r.currency,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screenshot_urls: (r as any).screenshot_urls ?? [],
    rating_avg: 0,
  })) as RecommendedApp[];
}

// ---------------------------------------------------------------------------
// Bundle suggestions — ≥2 subs from same vendor or reseller
// ---------------------------------------------------------------------------

export type BundleSuggestion = {
  vendor_id: string;
  vendor_name: string | null;
  sub_names: string[];
  other_apps: { id: string; name: string; price_cents: number; currency: string }[];
};

export async function getBundleSuggestions(buyerId: string): Promise<BundleSuggestion[]> {
  const admin = createAdminClient();

  const { data: subs } = await admin
    .from("subscriptions")
    .select("app_id, apps!inner(name, vendor_id, profiles!inner(display_name))")
    .eq("buyer_id", buyerId)
    .in("status", ["active", "trialing"]);

  if (!subs || subs.length < 2) return [];

  // Group by vendor
  const byVendor = new Map<
    string,
    { vendor_name: string | null; sub_names: string[]; subscribed_app_ids: string[] }
  >();

  for (const s of subs) {
    const app = s.apps as { name: string; vendor_id: string; profiles: { display_name: string | null } };
    const existing = byVendor.get(app.vendor_id);
    if (existing) {
      existing.sub_names.push(app.name);
      existing.subscribed_app_ids.push(s.app_id);
    } else {
      byVendor.set(app.vendor_id, {
        vendor_name: app.profiles.display_name,
        sub_names: [app.name],
        subscribed_app_ids: [s.app_id],
      });
    }
  }

  const suggestions: BundleSuggestion[] = [];

  for (const [vendor_id, info] of byVendor.entries()) {
    if (info.sub_names.length < 2) continue;

    // Find other apps from this vendor not yet subscribed
    const { data: others } = await admin
      .from("apps")
      .select("id, name, price_cents, currency")
      .eq("vendor_id", vendor_id)
      .eq("status", "approved")
      .not("id", "in", `(${info.subscribed_app_ids.join(",")})`)
      .limit(3);

    if (others && others.length > 0) {
      suggestions.push({
        vendor_id,
        vendor_name: info.vendor_name,
        sub_names: info.sub_names,
        other_apps: others,
      });
    }
  }

  return suggestions;
}
