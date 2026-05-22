import { getStripe } from "./client";
import { createAdminClient } from "@/lib/services/supabase";

export async function approveAppWithStripe(appId: string): Promise<{
  productId: string;
  priceId: string;
}> {
  const admin = createAdminClient();
  const { data: app, error: appErr } = await admin
    .from("apps")
    .select("id, name, price_cents, currency, stripe_product_id, stripe_price_id, vendor_id, status")
    .eq("id", appId)
    .single();
  if (appErr || !app) throw new Error(`App not found: ${appErr?.message}`);

  // Vendor must have charges_enabled
  const { data: vendor } = await admin
    .from("profiles")
    .select("charges_enabled")
    .eq("id", app.vendor_id)
    .single();
  if (!vendor?.charges_enabled) {
    throw new Error("Vendor must complete Stripe Connect onboarding before an app can be approved");
  }

  const stripe = getStripe();

  // Idempotent: reuse existing product if already created
  let productId = app.stripe_product_id ?? "";
  if (!productId) {
    const product = await stripe.products.create(
      { name: app.name, metadata: { app_id: appId } },
      { idempotencyKey: `product_create:app_${appId}` }
    );
    productId = product.id;
  }

  // Idempotent: reuse existing price if already created at same amount
  let priceId = app.stripe_price_id ?? "";
  if (!priceId) {
    priceId = await _createPrice(appId, productId, app.price_cents, app.currency);
  }

  // Atomically set status=approved + stripe ids in one update
  const { error: updateErr } = await admin
    .from("apps")
    .update({ status: "approved", stripe_product_id: productId, stripe_price_id: priceId })
    .eq("id", appId);
  if (updateErr) throw new Error(`Failed to update app: ${updateErr.message}`);

  return { productId, priceId };
}

export async function updateAppPrice(
  appId: string,
  newPriceCents: number
): Promise<{ priceId: string }> {
  const admin = createAdminClient();
  const { data: app, error: appErr } = await admin
    .from("apps")
    .select("stripe_product_id, currency")
    .eq("id", appId)
    .single();
  if (appErr || !app?.stripe_product_id) {
    throw new Error("App must have a Stripe product before updating price");
  }

  // Always create a new Price — never mutate; existing subscriptions keep their snapshot
  const priceId = await _createPrice(appId, app.stripe_product_id, newPriceCents, app.currency);

  // Atomically update price_cents + stripe_price_id
  const { error: updateErr } = await admin
    .from("apps")
    .update({ price_cents: newPriceCents, stripe_price_id: priceId })
    .eq("id", appId);
  if (updateErr) throw new Error(`Failed to update app price: ${updateErr.message}`);

  return { priceId };
}

async function _createPrice(
  appId: string,
  productId: string,
  unitAmount: number,
  currency: string
): Promise<string> {
  const stripe = getStripe();
  const price = await stripe.prices.create(
    {
      product: productId,
      unit_amount: unitAmount,
      currency,
      recurring: { interval: "month" },
      metadata: { app_id: appId },
    },
    { idempotencyKey: `price_create:app_${appId}:${unitAmount}` }
  );
  return price.id;
}
