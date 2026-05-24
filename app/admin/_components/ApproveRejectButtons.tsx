"use client";

import { useTransition, useState } from "react";
import { approveAppAction, rejectAppAction } from "../actions";

export default function ApproveRejectButtons({
  appId,
  chargesEnabled,
}: {
  appId: string;
  chargesEnabled: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function handle(action: "approve" | "reject") {
    startTransition(async () => {
      const result =
        action === "approve"
          ? await approveAppAction(appId)
          : await rejectAppAction(appId);
      if ("error" in result) setMsg(`Error: ${result.error}`);
      else setMsg(result.message ?? "Done");
    });
  }

  if (msg) return <span className="text-xs text-gray-700">{msg}</span>;

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => handle("approve")}
        disabled={isPending || !chargesEnabled}
        title={
          !chargesEnabled
            ? "Vendor must complete Stripe Connect first"
            : undefined
        }
        className="text-xs px-3 py-1 rounded-md bg-black text-white hover:bg-gray-800 disabled:opacity-40 transition-colors"
      >
        {isPending ? "…" : "Approve"}
      </button>
      <button
        onClick={() => handle("reject")}
        disabled={isPending}
        className="text-xs px-3 py-1 rounded-md border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40 transition-colors"
      >
        Reject
      </button>
    </div>
  );
}
