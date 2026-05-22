"use client";

import { useTransition } from "react";
import { updateOfferStatusAction } from "@/app/reseller/actions";
import type { Database } from "@/types/supabase";

type ResellerOfferStatus = Database["public"]["Enums"]["reseller_offer_status"];

interface Offer {
  id: string;
  status: ResellerOfferStatus;
}

export default function OfferStatusButton({
  offer,
  canPublish,
}: {
  offer: Offer;
  canPublish: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next: ResellerOfferStatus =
      offer.status === "active" ? "paused" : "active";
    startTransition(() => {
      updateOfferStatusAction(offer.id, next);
    });
  }

  if (offer.status === "active") {
    return (
      <button
        onClick={toggle}
        disabled={pending}
        className="text-xs px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
      >
        Pause
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      disabled={pending || !canPublish}
      title={!canPublish ? "Complete setup to publish offers" : undefined}
      className="text-xs px-3 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      Publish
    </button>
  );
}
