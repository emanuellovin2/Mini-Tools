"use client";

import { useState } from "react";
import { previewBuyer } from "@/lib/pricing/preview";
import Link from "next/link";

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

export function BuyerFeeBreakdown({
  priceCents,
  channel = "direct",
  cutBps,
  affiliateCommBps,
  resellerFloorCents,
  resellerWlTier,
  vendorOpenness,
}: {
  priceCents: number;
  channel?: "direct" | "affiliate" | "reseller";
  cutBps?: number;
  affiliateCommBps?: number;
  resellerFloorCents?: number;
  resellerWlTier?: 1 | 2;
  vendorOpenness?: "open_to_resellers" | "open_to_wl";
}) {
  const [open, setOpen] = useState(false);

  const preview = previewBuyer({
    priceCents,
    channel,
    cutBps,
    affiliateCommBps,
    resellerFloorCents,
    resellerWlTier,
    vendorOpenness,
  });

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-gray-500 underline hover:text-gray-700 transition-colors"
      >
        {open ? "Hide" : "How this is split"} ↕
      </button>
      {open && (
        <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs space-y-1">
          <div className="flex justify-between text-gray-600">
            <span>Vendor receives</span>
            <span className="tabular-nums font-mono">{fmt(preview.vendorCents)}</span>
          </div>
          <div className="flex justify-between text-gray-600">
            <span>Platform fee</span>
            <span className="tabular-nums font-mono">{fmt(preview.platformCents)}</span>
          </div>
          {preview.affiliateCents != null && preview.affiliateCents > 0 && (
            <div className="flex justify-between text-gray-600">
              <span>Affiliate commission</span>
              <span className="tabular-nums font-mono">{fmt(preview.affiliateCents)}</span>
            </div>
          )}
          {preview.resellerCents != null && preview.resellerCents > 0 && (
            <div className="flex justify-between text-gray-600">
              <span>Reseller margin</span>
              <span className="tabular-nums font-mono">{fmt(preview.resellerCents)}</span>
            </div>
          )}
          <div className="flex justify-between text-gray-600">
            <span>Stripe processing fee</span>
            <span className="tabular-nums font-mono">{fmt(preview.stripeFeeCents)}</span>
          </div>
          <div className="flex justify-between font-semibold text-gray-900 border-t border-gray-200 pt-1">
            <span>Total you pay</span>
            <span className="tabular-nums font-mono">{fmt(preview.grossCents)}/mo</span>
          </div>
          <p className="text-gray-400 pt-1">
            <Link href="/legal/fees" className="underline hover:text-gray-600">
              Full fee schedule →
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
