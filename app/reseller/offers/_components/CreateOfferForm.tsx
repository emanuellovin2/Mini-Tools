"use client";

import { useActionState, useTransition, useState, useMemo } from "react";
import { createOfferAction } from "@/app/reseller/actions";
import type { ActionResult } from "@/app/reseller/actions";
import { previewReseller } from "@/lib/pricing/preview";

interface App {
  id: string;
  name: string;
  price_cents: number;
  min_price_cents: number | null;
  profiles: { display_name: string | null } | null;
}

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function Row({
  label,
  value,
  negative,
  highlight,
}: {
  label: string;
  value: string;
  negative?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex justify-between text-[12px] ${
        highlight
          ? "font-semibold text-gray-900"
          : negative
          ? "text-red-600"
          : "text-gray-600"
      }`}
    >
      <span>{label}</span>
      <span className="tabular-nums font-mono">{value}</span>
    </div>
  );
}

function MarginPreview({
  selectedApp,
  sellPriceDollars,
}: {
  selectedApp: App;
  sellPriceDollars: number;
}) {
  const floorCents = selectedApp.min_price_cents ?? 0;
  const sellPriceCents = Math.round(sellPriceDollars * 100);
  // Use conservative default — Tier 2 comparison shows in the offer settings if vendor is open_to_wl
  const openness: "open_to_resellers" = "open_to_resellers";

  const preview = useMemo(
    () =>
      sellPriceCents > floorCents
        ? previewReseller({ floorCents, sellPriceCents, vendorOpenness: openness })
        : null,
    [floorCents, sellPriceCents, openness]
  );

  if (sellPriceDollars <= 0 || !preview) return null;

  const hasT2 = preview.tier2 !== null;

  return (
    <div className="mt-2 bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-1">
      <Row label="Your sell price" value={fmt(preview.grossCents)} />
      <Row label="Stripe fee (~2.9% + $0.30)" value={`−${fmt(preview.stripeFeeCents)}`} negative />
      <Row label="Net" value={fmt(preview.netCents)} />
      <Row label="Vendor floor" value={`−${fmt(preview.vendorFloorCents)}`} negative />
      <Row label="Markup" value={fmt(preview.markupCents)} />
      <div className="border-t border-blue-200 my-1" />
      <Row
        label="Platform cut (5% of markup — Tier 1)"
        value={`−${fmt(preview.tier1.platformCutCents)}`}
        negative
      />
      <Row
        label="Your margin / sale (Tier 1)"
        value={fmt(preview.tier1.resellerCents)}
        highlight={!hasT2}
      />

      {hasT2 && preview.tier2 && (
        <>
          <div className="border-t border-blue-200 my-1" />
          <p className="text-[11px] font-medium text-blue-700">Upgrade to Tier 2 WL (+$29/mo):</p>
          <Row
            label="Platform cut (2.5% of markup — Tier 2)"
            value={`−${fmt(preview.tier2.platformCutCents)}`}
            negative
          />
          <Row
            label="Your margin / sale (Tier 2)"
            value={fmt(preview.tier2.resellerCents)}
            highlight
          />
          {preview.breakEvenSales !== null && (
            <p className="text-[11px] text-gray-500 pt-0.5">
              Extra per sale: +{fmt(preview.tier2.resellerCents - preview.tier1.resellerCents)} ·
              Break-even: {preview.breakEvenSales} sales/mo
            </p>
          )}
        </>
      )}

      {preview.tier2 && (
        <p className="text-[11px] text-green-700 pt-1 border-t border-blue-200">
          Vendor gets a 33% kickback on platform commission (open to WL).
        </p>
      )}

      <p className="text-[11px] text-gray-400 pt-0.5">
        <a href="/legal/fees" className="underline hover:text-gray-600" target="_blank" rel="noreferrer">
          How fees work →
        </a>
      </p>
    </div>
  );
}

export default function CreateOfferForm({ apps }: { apps: App[] }) {
  const [result, dispatch] = useActionState<ActionResult | null, FormData>(
    createOfferAction,
    null
  );
  const [, startTransition] = useTransition();
  const [selectedApp, setSelectedApp] = useState<App | null>(null);
  const [sellPriceDollars, setSellPriceDollars] = useState(0);

  const fieldErrors =
    result && "error" in result && typeof result.error === "object"
      ? (result.error as Record<string, string[]>)
      : null;
  const topError =
    result && "error" in result && typeof result.error === "string" ? result.error : null;
  const success = result && "success" in result && result.success;

  return (
    <form
      action={(fd) => startTransition(() => { dispatch(fd); })}
      className="space-y-4"
    >
      {success && (
        <p className="text-green-600 text-sm">Offer created successfully.</p>
      )}
      {topError && <p className="text-red-600 text-sm">{topError}</p>}

      <div>
        <label className="block text-sm font-medium mb-1">App</label>
        <select
          name="app_id"
          required
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          onChange={(e) => {
            const app = apps.find((a) => a.id === e.target.value) ?? null;
            setSelectedApp(app);
            setSellPriceDollars(0);
          }}
        >
          <option value="">— Select an app —</option>
          {apps.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name} (floor ${app.min_price_cents !== null ? (app.min_price_cents / 100).toFixed(2) : "—"}/mo)
            </option>
          ))}
        </select>
        {fieldErrors?.app_id && (
          <p className="text-red-600 text-xs mt-1">{fieldErrors.app_id[0]}</p>
        )}
        {selectedApp && (
          <p className="text-xs text-gray-700 mt-1">
            Direct price: ${(selectedApp.price_cents / 100).toFixed(2)}/mo · Vendor floor: $
            {selectedApp.min_price_cents !== null
              ? (selectedApp.min_price_cents / 100).toFixed(2)
              : "—"}
            /mo
          </p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Your sell price ($/mo)</label>
        <input
          name="sell_price_dollars"
          type="number"
          step="0.01"
          min={
            selectedApp?.min_price_cents !== null && selectedApp?.min_price_cents !== undefined
              ? ((selectedApp.min_price_cents) / 100 + 0.01).toFixed(2)
              : "0.01"
          }
          required
          placeholder="e.g. 49.99"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          onChange={(e) => setSellPriceDollars(parseFloat(e.target.value) || 0)}
        />
        {fieldErrors?.sell_price_dollars && (
          <p className="text-red-600 text-xs mt-1">{fieldErrors.sell_price_dollars[0]}</p>
        )}

        {selectedApp && selectedApp.min_price_cents !== null && (
          <MarginPreview selectedApp={selectedApp} sellPriceDollars={sellPriceDollars} />
        )}

        {!selectedApp && (
          <p className="text-xs text-gray-700 mt-1">
            Must be above the vendor floor. Platform takes 5% of markup; you keep the rest.{" "}
            <a href="/legal/fees" className="underline" target="_blank" rel="noreferrer">
              How fees work →
            </a>
          </p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Offer slug</label>
        <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden text-sm">
          <span className="px-3 py-2 bg-gray-50 text-gray-700 border-r border-gray-300 shrink-0">
            /r/your-store/
          </span>
          <input
            name="slug"
            type="text"
            placeholder="app-deal"
            required
            className="flex-1 px-3 py-2 focus:outline-none"
          />
        </div>
        {fieldErrors?.slug && (
          <p className="text-red-600 text-xs mt-1">{fieldErrors.slug[0]}</p>
        )}
      </div>

      <button
        type="submit"
        className="w-full py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
      >
        Create offer
      </button>
    </form>
  );
}
