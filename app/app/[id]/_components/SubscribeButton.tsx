"use client";

import { useState } from "react";
import { subscribeAction } from "../actions";

export default function SubscribeButton({ appId }: { appId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubscribe() {
    setLoading(true);
    setError(null);
    const result = await subscribeAction(appId);
    if ("error" in result) {
      setError(result.error);
      setLoading(false);
    } else {
      window.location.href = result.url;
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        onClick={handleSubscribe}
        disabled={loading}
        className="bg-black text-white px-6 py-3 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50"
      >
        {loading ? "Redirecting…" : "Subscribe"}
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
