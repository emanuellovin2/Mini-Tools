"use client";

import { useState, useTransition } from "react";
import { createAffiliateLinkAction } from "../actions";
import { getAffiliateCommissionBps } from "@/lib/stripe/transfers";
import { previewAffiliate } from "@/lib/pricing/preview";

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function TierProjections({
  activeMrrCents,
}: {
  activeMrrCents: number;
}) {
  const currentTierBps = getAffiliateCommissionBps(activeMrrCents);
  const currentPct = (currentTierBps / 100).toFixed(0);

  return (
    <div className="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-3 text-[12px] space-y-1.5">
      <p className="font-medium text-gray-700">Your current tier: {currentPct}% commission cap</p>
      <div className="space-y-0.5 text-gray-600">
        <div className={`flex justify-between ${activeMrrCents < 500_000 ? "font-semibold text-blue-700" : "opacity-60"}`}>
          <span>Tier 1 (up to $5k active MRR)</span>
          <span>20% of net per sale</span>
        </div>
        <div className={`flex justify-between ${activeMrrCents >= 500_000 && activeMrrCents < 2_000_000 ? "font-semibold text-blue-700" : activeMrrCents >= 500_000 ? "opacity-60" : "opacity-40"}`}>
          <span>Tier 2 ($5k+ active MRR)</span>
          <span>25% of net per sale</span>
        </div>
        <div className={`flex justify-between ${activeMrrCents >= 2_000_000 ? "font-semibold text-blue-700" : "opacity-40"}`}>
          <span>Tier 3 ($20k+ active MRR)</span>
          <span>30% of net per sale</span>
        </div>
      </div>
      <p className="text-gray-400 text-[11px]">
        Commission is capped at your tier but also bounded by the vendor&apos;s offered rate per app.{" "}
        <a href="/legal/fees" className="underline hover:text-gray-600" target="_blank" rel="noreferrer">
          How commissions work →
        </a>
      </p>
    </div>
  );
}

function AppEarningsPreview({
  appCommissionBps,
  appPriceCents,
  affiliateTierBps,
}: {
  appCommissionBps: number;
  appPriceCents: number;
  affiliateTierBps: number;
}) {
  const preview = previewAffiliate({
    priceCents: appPriceCents,
    vendorOfferedBps: appCommissionBps,
    affiliateTierBps,
  });

  return (
    <div className="mt-2 bg-green-50 border border-green-200 rounded-lg p-3 text-[12px] space-y-1">
      <p className="font-medium text-gray-700">
        Vendor offers {(appCommissionBps / 100).toFixed(0)}% — you earn{" "}
        {(preview.clampedBps / 100).toFixed(0)}% (your tier cap)
      </p>
      <div className="flex justify-between text-gray-600">
        <span>App price</span>
        <span className="tabular-nums font-mono">{fmt(appPriceCents)}/mo</span>
      </div>
      <div className="flex justify-between text-gray-600">
        <span>After Stripe fee</span>
        <span className="tabular-nums font-mono">{fmt(preview.netCents)}/mo</span>
      </div>
      <div className="flex justify-between font-semibold text-green-700">
        <span>You earn per sub/mo</span>
        <span className="tabular-nums font-mono">{fmt(preview.affiliateCents)}</span>
      </div>
      <div className="flex justify-between text-gray-500">
        <span>At 10 active subs</span>
        <span className="tabular-nums font-mono">{fmt(preview.affiliateCents * 10)}/mo</span>
      </div>
      {preview.tierProjections.length > 0 && preview.clampedBps < preview.vendorOfferedBps && (
        <div className="pt-1 border-t border-green-200 space-y-0.5">
          <p className="text-[11px] text-gray-500">Potential with tier upgrades:</p>
          {preview.tierProjections
            .filter((t) => t.tierBps > preview.clampedBps)
            .map((t) => (
              <div key={t.tierBps} className="flex justify-between text-gray-500">
                <span>{t.thresholdLabel}</span>
                <span className="tabular-nums font-mono">{fmt(t.affiliateCents)}/sub</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export default function GenerateLinkForm({
  activeMrrCents = 0,
  appCatalog = [],
}: {
  activeMrrCents?: number;
  appCatalog?: Array<{ id: string; name: string; price_cents: number; affiliate_commission_bps: number | null }>;
}) {
  const [result, setResult] = useState<{ code: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [selectedAppId, setSelectedAppId] = useState("");

  const affiliateTierBps = getAffiliateCommissionBps(activeMrrCents);
  const selectedApp = appCatalog.find((a) => a.id === selectedAppId) ?? null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    setResult(null);
    setCopied(false);
    startTransition(async () => {
      const res = await createAffiliateLinkAction(fd);
      if ("error" in res) {
        setError(res.error);
      } else {
        setResult(res);
      }
    });
  }

  async function copyUrl() {
    if (!result) return;
    await navigator.clipboard.writeText(result.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">Generate Referral Link</h2>

      <TierProjections activeMrrCents={activeMrrCents} />

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 mt-4">
        <div>
          <label className="block text-xs text-gray-700 mb-1">
            App (optional — leave blank for a generic link)
          </label>
          {appCatalog.length > 0 ? (
            <select
              name="app_id"
              value={selectedAppId}
              onChange={(e) => setSelectedAppId(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
            >
              <option value="">— Generic link (no specific app) —</option>
              {appCatalog.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name} — {app.affiliate_commission_bps != null ? `${(app.affiliate_commission_bps / 100).toFixed(0)}% commission` : "no commission"}
                </option>
              ))}
            </select>
          ) : (
            <input
              name="app_id"
              type="text"
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-black"
            />
          )}

          {selectedApp && selectedApp.affiliate_commission_bps !== null && (
            <AppEarningsPreview
              appCommissionBps={selectedApp.affiliate_commission_bps}
              appPriceCents={selectedApp.price_cents}
              affiliateTierBps={affiliateTierBps}
            />
          )}
        </div>

        <button
          type="submit"
          disabled={isPending}
          className="self-start bg-black text-white px-4 py-2 rounded text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
        >
          {isPending ? "Generating…" : "Generate Link"}
        </button>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {result && (
          <div className="mt-2 bg-gray-50 border border-gray-200 rounded p-3 flex items-center justify-between gap-3">
            <span className="font-mono text-xs text-gray-700 break-all">{result.url}</span>
            <button
              type="button"
              onClick={copyUrl}
              className="shrink-0 text-xs text-black underline"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
