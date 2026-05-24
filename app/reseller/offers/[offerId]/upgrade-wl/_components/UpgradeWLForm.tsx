"use client";

import { useActionState } from "react";
import { upgradeOfferToWLTier2Action } from "@/app/reseller/actions";

export default function UpgradeWLForm({ offerId }: { offerId: string }) {
  const [state, action, pending] = useActionState(upgradeOfferToWLTier2Action, null);

  if ("success" in (state ?? {}) && (state as { success?: boolean })?.success) {
    return (
      <div className="text-green-700 text-sm font-medium">
        Tier 2 activated! Your subdomain storefront is live.{" "}
        <a href="/reseller/offers" className="underline">Back to offers</a>
      </div>
    );
  }

  return (
    <form action={action} encType="multipart/form-data" className="space-y-4">
      <input type="hidden" name="offer_id" value={offerId} />

      <div>
        <label className="block text-sm font-medium mb-1">Brand Logo</label>
        <input
          type="file"
          name="logo"
          accept="image/png,image/jpeg,image/webp"
          required
          className="block w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-200 file:text-xs file:bg-white hover:file:bg-gray-50"
        />
        <p className="text-xs text-gray-400 mt-1">PNG, JPG, or WebP · max 1 MB</p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Brand Color</label>
        <div className="flex items-center gap-3">
          <input
            type="color"
            name="brand_color"
            defaultValue="#6366f1"
            className="h-9 w-16 rounded border border-gray-200 cursor-pointer"
          />
          <span className="text-xs text-gray-400">Applied to storefront header and emails</span>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Display Name</label>
        <input
          type="text"
          name="display_name"
          placeholder="Your Brand"
          maxLength={64}
          required
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300"
        />
        <p className="text-xs text-gray-400 mt-1">Shown in storefront header and email receipts</p>
      </div>

      {"error" in (state ?? {}) && (
        <p className="text-xs text-red-500">
          {typeof (state as { error: unknown }).error === "string"
            ? (state as { error: string }).error
            : "Something went wrong"}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full bg-indigo-600 text-white rounded-xl py-2.5 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? "Activating…" : "Subscribe — $29/mo"}
      </button>
    </form>
  );
}
