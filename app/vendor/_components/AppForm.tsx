"use client";

import { useActionState, useState } from "react";
import { submitAppAction, type ActionResult } from "../actions";
import ScreenshotUploader from "./ScreenshotUploader";
import { previewVendorDirect } from "@/lib/pricing/preview";

const inputClass =
  "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black";

function FieldError({ msg }: { msg: string }) {
  return <p className="text-red-500 text-xs mt-1">{msg}</p>;
}

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function VendorPricePreview({
  priceDollars,
  cutBps,
  overrideBps,
  currentNetMrrCents,
}: {
  priceDollars: number;
  cutBps: number;
  overrideBps: number | null;
  currentNetMrrCents: number;
}) {
  if (priceDollars <= 0) return null;
  const priceCents = Math.round(priceDollars * 100);
  const preview = previewVendorDirect({ priceCents, currentNetMrrCents, overrideBps });

  const pct = (bps: number) => (bps / 100).toFixed(0) + "%";

  return (
    <div className="mt-2 bg-blue-50 border border-blue-200 rounded-lg p-3 text-[12px] space-y-1">
      <div className="flex justify-between text-gray-600">
        <span>Gross per sale</span>
        <span className="tabular-nums font-mono">{fmt(preview.grossCents)}</span>
      </div>
      <div className="flex justify-between text-gray-600">
        <span>Stripe fee (~2.9% + $0.30)</span>
        <span className="tabular-nums font-mono text-red-600">−{fmt(preview.stripeFeeCents)}</span>
      </div>
      <div className="flex justify-between text-gray-600 border-t border-blue-200 pt-1">
        <span>Net amount</span>
        <span className="tabular-nums font-mono">{fmt(preview.netCents)}</span>
      </div>
      <div className="flex justify-between text-gray-600">
        <span>
          Platform fee ({preview.isOverride ? "custom override" : `auto tier`} {pct(preview.cutBps)})
        </span>
        <span className="tabular-nums font-mono text-red-600">−{fmt(preview.platformCutCents)}</span>
      </div>
      <div className="flex justify-between font-semibold text-gray-900 border-t border-blue-200 pt-1">
        <span>You receive per sale</span>
        <span className="tabular-nums font-mono text-green-700">{fmt(preview.vendorCents)}</span>
      </div>
      {preview.nextTier && (
        <p className="text-gray-500 pt-1 border-t border-blue-200">
          At {preview.nextTier.label}/mo net MRR (tier {pct(preview.nextTier.bps)}
          ): <strong>{fmt(preview.nextTier.vendorCents)}</strong> per sale (+
          {fmt(preview.nextTier.vendorCents - preview.vendorCents)})
        </p>
      )}
      <p className="text-gray-400 pt-0.5">
        <a href="/legal/fees" className="underline hover:text-gray-600" target="_blank" rel="noreferrer">
          How fees work →
        </a>
      </p>
    </div>
  );
}

export default function AppForm({
  cutBps = 1200,
  overrideBps = null,
  currentNetMrrCents = 0,
}: {
  cutBps?: number;
  overrideBps?: number | null;
  currentNetMrrCents?: number;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    submitAppAction,
    null
  );
  const [priceDollars, setPriceDollars] = useState(0);

  const fieldErrors =
    state && "error" in state && typeof state.error === "object" && state.error !== null
      ? (state.error as Record<string, string[]>)
      : null;
  const generalError =
    state && "error" in state && typeof state.error === "string"
      ? state.error
      : null;

  return (
    <form action={action} className="space-y-4">
      <div>
        <label className="block text-sm text-gray-700 mb-1">
          Name <span className="text-red-500">*</span>
        </label>
        <input name="name" className={inputClass} placeholder="My SaaS Tool" required />
        {fieldErrors?.name && <FieldError msg={fieldErrors.name[0]} />}
      </div>

      <div>
        <label className="block text-sm text-gray-700 mb-1">Description</label>
        <textarea
          name="description"
          rows={3}
          className={inputClass + " resize-none"}
          placeholder="What does your app do?"
        />
        {fieldErrors?.description && <FieldError msg={fieldErrors.description[0]} />}
      </div>

      <div>
        <label className="block text-sm text-gray-700 mb-1">Category</label>
        <input
          name="category"
          className={inputClass}
          placeholder="e.g. AI Writing, CRM, Analytics"
        />
        {fieldErrors?.category && <FieldError msg={fieldErrors.category[0]} />}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-gray-700 mb-1">
            Price ($/month) <span className="text-red-500">*</span>
          </label>
          <input
            name="price_dollars"
            type="number"
            step="0.01"
            min="0.01"
            className={inputClass}
            placeholder="9.99"
            required
            onChange={(e) => setPriceDollars(parseFloat(e.target.value) || 0)}
          />
          {fieldErrors?.price_dollars && <FieldError msg={fieldErrors.price_dollars[0]} />}
          <VendorPricePreview
            priceDollars={priceDollars}
            cutBps={cutBps}
            overrideBps={overrideBps}
            currentNetMrrCents={currentNetMrrCents}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-700 mb-1">
            Resell floor ($/month)
            <span className="ml-1 text-xs text-gray-700" title="Leave blank to disable resell">
              opt-in
            </span>
          </label>
          <input
            name="min_price_dollars"
            type="number"
            step="0.01"
            min="0"
            className={inputClass}
            placeholder="blank = no resell"
          />
          {fieldErrors?.min_price_dollars && (
            <FieldError msg={fieldErrors.min_price_dollars[0]} />
          )}
        </div>
      </div>

      <div>
        <label className="block text-sm text-gray-700 mb-1">
          Auth URL (https) <span className="text-red-500">*</span>
        </label>
        <input
          name="auth_url"
          type="url"
          className={inputClass}
          placeholder="https://yourapp.com/auth"
          required
        />
        {fieldErrors?.auth_url && <FieldError msg={fieldErrors.auth_url[0]} />}
      </div>

      <div>
        <label className="block text-sm text-gray-700 mb-1">
          Logo (PNG, JPG, or WebP — max 1 MB)
        </label>
        <input
          name="logo"
          type="file"
          accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
          className="text-sm text-gray-600 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
        />
        {fieldErrors?.logo && <FieldError msg={fieldErrors.logo[0]} />}
      </div>

      <div>
        <label className="block text-sm text-gray-700 mb-2">
          Screenshots <span className="text-red-500">*</span>
          <span className="ml-1 text-xs text-gray-500 font-normal">
            3–7 images, PNG/JPG/WebP, max 1 MB each. First image is the marketplace preview.
          </span>
        </label>
        <ScreenshotUploader />
        {fieldErrors?.screenshot_urls && <FieldError msg={fieldErrors.screenshot_urls[0]} />}
      </div>

      {generalError && <p className="text-red-500 text-sm">{generalError}</p>}

      <button
        type="submit"
        disabled={pending}
        className="w-full bg-black text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
      >
        {pending ? "Submitting…" : "Submit for Review"}
      </button>

      {state && "success" in state && (
        <p className="text-green-600 text-sm text-center">
          App submitted! It will appear as pending review.
        </p>
      )}
    </form>
  );
}
