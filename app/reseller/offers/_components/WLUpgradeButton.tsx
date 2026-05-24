"use client";

import { useTransition } from "react";
import { upgradeOfferToWLTier2Action, cancelWLTier2Action } from "@/app/reseller/actions";

export default function WLUpgradeButton({
  offerId,
  wlStatus,
}: {
  offerId: string;
  wlStatus: string | null;
}) {
  const [pending, startTransition] = useTransition();

  const isActive = wlStatus === "active" || wlStatus === "trialing";

  if (isActive) {
    return (
      <button
        disabled={pending}
        onClick={() => startTransition(() => { cancelWLTier2Action(offerId); })}
        className="text-xs px-3 py-1 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50"
      >
        {pending ? "Canceling…" : "Cancel WL ($29/mo)"}
      </button>
    );
  }

  return (
    <a
      href={`/reseller/offers/${offerId}/upgrade-wl`}
      className="text-xs px-3 py-1 border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-50"
    >
      Upgrade to WL Tier 2
    </a>
  );
}
