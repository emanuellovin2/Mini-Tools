"use client";

import { useState } from "react";

type Props = {
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
};

export default function StripeConnect({ stripeAccountId, chargesEnabled, payoutsEnabled }: Props) {
  const [loading, setLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ charges_enabled: boolean; payouts_enabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentCharges = syncStatus?.charges_enabled ?? chargesEnabled;
  const currentPayouts = syncStatus?.payouts_enabled ?? payoutsEnabled;

  async function handleConnect() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/connect", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start onboarding");
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setLoading(false);
    }
  }

  async function handleSync() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to sync status");
      setSyncStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${currentCharges ? "bg-green-500" : "bg-gray-300"}`} />
        <span className="text-sm text-gray-600">
          {currentCharges ? "Stripe connected" : "Stripe not connected"}
        </span>
      </div>

      {currentCharges && (
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${currentPayouts ? "bg-green-500" : "bg-yellow-400"}`} />
          <span className="text-xs text-gray-700">
            {currentPayouts ? "Payouts enabled" : "Payouts pending"}
          </span>
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex flex-col gap-2 pt-1">
        {!currentCharges && (
          <button
            onClick={handleConnect}
            disabled={loading}
            className="text-sm bg-indigo-600 text-white rounded-lg px-4 py-2 hover:bg-indigo-700 transition-colors disabled:opacity-50"
          >
            {loading ? "Redirecting…" : stripeAccountId ? "Resume onboarding" : "Connect Stripe"}
          </button>
        )}

        {stripeAccountId && (
          <button
            onClick={handleSync}
            disabled={loading}
            className="text-sm border border-gray-200 text-gray-600 rounded-lg px-4 py-2 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            {loading ? "Syncing…" : "Sync Stripe status"}
          </button>
        )}
      </div>
    </div>
  );
}
