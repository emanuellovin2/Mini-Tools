import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getActiveOrg } from "@/lib/services/org";
import { getAgencyBalance, getAgencyPayouts } from "@/lib/services/agency";
import AgencyBalanceCard from "../_components/AgencyBalanceCard";

export const metadata: Metadata = { title: "Agency Payouts — [PLATFORM]" };

export default async function AgencyPayoutsPage() {
  const { org } = await getActiveOrg();
  if (org.type !== "agency") redirect("/login");

  const [balance, payouts] = await Promise.all([
    getAgencyBalance(org.id),
    getAgencyPayouts(org.id, 20),
  ]);

  return (
    <div className="p-6 max-w-[600px] mx-auto space-y-6">
      <div>
        <h1 className="text-[17px] font-semibold text-foreground">Payouts</h1>
        <p className="text-[13px] text-muted-foreground mt-0.5">
          Stripe Connect balance and payout history for {org.name}.
        </p>
      </div>
      <AgencyBalanceCard balance={balance} payouts={payouts} />
    </div>
  );
}
