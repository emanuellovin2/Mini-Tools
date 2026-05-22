import { getStripe } from "./client";
import { createAdminClient } from "@/lib/services/supabase";

// One Stripe Customer per buyer, reused across all their subscriptions.
export async function getOrCreateStripeCustomer(
  buyerId: string,
  email: string
): Promise<string> {
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", buyerId)
    .single();

  if (profile?.stripe_customer_id) return profile.stripe_customer_id;

  const stripe = getStripe();
  const customer = await stripe.customers.create(
    { email, metadata: { buyer_id: buyerId } },
    { idempotencyKey: `customer_create:buyer_${buyerId}` }
  );

  const { error } = await admin
    .from("profiles")
    .update({ stripe_customer_id: customer.id })
    .eq("id", buyerId);
  if (error) throw new Error(`Failed to store stripe_customer_id: ${error.message}`);

  return customer.id;
}
