"use client";

import { useActionState, useState } from "react";
import { updateAffiliateCommissionAction, type ActionResult } from "../actions";

interface Props {
  appId: string;
  currentBps: number | null;
}

export default function AffiliateCommissionForm({ appId, currentBps }: Props) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    updateAffiliateCommissionAction,
    null
  );
  const [pct, setPct] = useState<string>(
    currentBps !== null ? String(currentBps / 100) : ""
  );

  const affiliatePct = parseFloat(pct) || 0;
  const totalCost = affiliatePct > 0 ? affiliatePct + 5 : 0;
  const bps = Math.round(affiliatePct * 100);
  const valid = affiliatePct === 0 || (bps >= 2000 && bps <= 8000);

  const fieldErrors =
    state && "error" in state && typeof state.error === "object" && state.error !== null
      ? (state.error as Record<string, string[]>)
      : null;
  const generalError =
    state && "error" in state && typeof state.error === "string" ? state.error : null;

  return (
    <form action={action} className="mt-3 pt-3 border-t border-gray-100">
      <input type="hidden" name="app_id" value={appId} />
      <p className="text-xs font-medium text-gray-600 mb-2">Affiliate program</p>
      <div className="flex items-center gap-2">
        <input
          name="affiliate_commission_bps"
          type="number"
          min="20"
          max="80"
          step="1"
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          placeholder="e.g. 20"
          className="w-20 border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-black"
        />
        <span className="text-xs text-gray-500">%</span>
        <button
          type="submit"
          disabled={pending || !valid}
          className="text-xs bg-black text-white px-3 py-1 rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {currentBps !== null && (
          <button
            type="submit"
            name="affiliate_commission_bps"
            value=""
            disabled={pending}
            className="text-xs text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50"
          >
            Disable
          </button>
        )}
      </div>

      {affiliatePct > 0 && valid && (
        <p className="text-xs text-gray-500 mt-1.5">
          You pay{" "}
          <strong className="text-gray-700">{affiliatePct}%</strong> to affiliate +{" "}
          <strong className="text-gray-700">5%</strong> platform ={" "}
          <strong className="text-gray-700">{totalCost}%</strong> total per sale
        </p>
      )}
      {affiliatePct > 0 && !valid && (
        <p className="text-xs text-red-500 mt-1">Must be between 20% and 80%</p>
      )}
      {fieldErrors?.affiliate_commission_bps && (
        <p className="text-xs text-red-500 mt-1">{fieldErrors.affiliate_commission_bps[0]}</p>
      )}
      {generalError && <p className="text-xs text-red-500 mt-1">{generalError}</p>}
      {state && "success" in state && (
        <p className="text-xs text-green-600 mt-1">Saved.</p>
      )}
    </form>
  );
}
