"use client";

import { useActionState, useTransition, useState } from "react";
import { createOfferAction } from "@/app/reseller/actions";
import type { ActionResult } from "@/app/reseller/actions";

interface App {
  id: string;
  name: string;
  price_cents: number;
  min_price_cents: number | null;
  profiles: { display_name: string | null } | null;
}

export default function CreateOfferForm({ apps }: { apps: App[] }) {
  const [result, dispatch] = useActionState<ActionResult | null, FormData>(
    createOfferAction,
    null
  );
  const [, startTransition] = useTransition();
  const [selectedApp, setSelectedApp] = useState<App | null>(null);

  const fieldErrors =
    result && "error" in result && typeof result.error === "object"
      ? (result.error as Record<string, string[]>)
      : null;
  const topError =
    result && "error" in result && typeof result.error === "string" ? result.error : null;
  const success = result && "success" in result && result.success;

  function formatCents(cents: number) {
    return (cents / 100).toFixed(2);
  }

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
          }}
        >
          <option value="">— Select an app —</option>
          {apps.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name} (floor ${app.min_price_cents !== null ? formatCents(app.min_price_cents) : "—"}/mo)
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
              ? formatCents(selectedApp.min_price_cents)
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
        />
        {fieldErrors?.sell_price_dollars && (
          <p className="text-red-600 text-xs mt-1">{fieldErrors.sell_price_dollars[0]}</p>
        )}
        <p className="text-xs text-gray-700 mt-1">
          Must be above the vendor floor. Platform takes 5%; you keep the rest of the markup.
        </p>
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
