/**
 * One-time script: set weekly Friday payout schedule on all already-onboarded Connect accounts.
 * Run once after deploying #20, then delete this file.
 *
 * Usage: npx ts-node -r tsconfig-paths/register scripts/set-weekly-payouts.ts
 */
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-04-22.dahlia",
});

async function main() {
  const { data, error } = await admin
    .from("profiles")
    .select("stripe_account_id")
    .eq("charges_enabled", true)
    .not("stripe_account_id", "is", null);

  if (error) throw new Error(`DB query failed: ${error.message}`);
  if (!data?.length) {
    console.log("No accounts to update.");
    return;
  }

  console.log(`Updating ${data.length} account(s)...`);
  for (const { stripe_account_id } of data) {
    try {
      await stripe.accounts.update(stripe_account_id!, {
        settings: {
          payouts: {
            schedule: { interval: "weekly", weekly_anchor: "friday" },
            debit_negative_balances: true,
          },
        },
      });
      console.log(`✓ ${stripe_account_id}`);
    } catch (err) {
      console.error(`✗ ${stripe_account_id}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
