"use client";

import { useTransition, useState } from "react";
import { syncVendorStripeAction } from "../actions";

export default function SyncStripeButton({ vendorId }: { vendorId: string }) {
  const [isPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function handleSync() {
    startTransition(async () => {
      const result = await syncVendorStripeAction(vendorId);
      if ("error" in result) setMsg(`Error: ${result.error}`);
      else setMsg(result.message ?? "Synced");
      setTimeout(() => setMsg(null), 3000);
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleSync}
        disabled={isPending}
        className="text-xs px-3 py-1 rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-40 transition-colors"
      >
        {isPending ? "Syncing…" : "Sync Stripe"}
      </button>
      {msg && <span className="text-xs text-gray-700">{msg}</span>}
    </div>
  );
}
