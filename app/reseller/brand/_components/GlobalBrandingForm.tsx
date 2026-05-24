"use client";

import { useActionState, useRef } from "react";
import { setResellerGlobalBrandingAction, clearResellerGlobalBrandingAction } from "@/app/reseller/brand/actions";
import { validateWLBrand, WL_COLOR_REGEX } from "@/lib/validation/wl-brand";
import type { ActionResult } from "@/app/reseller/brand/actions";

interface Props {
  currentBranding: { logoUrl: string; brandColor: string; displayName: string } | null;
}

export default function GlobalBrandingForm({ currentBranding }: Props) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    setResellerGlobalBrandingAction,
    null
  );
  const [clearState, clearAction, clearPending] = useActionState<ActionResult | null, FormData>(
    clearResellerGlobalBrandingAction,
    null
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const errorMsg = state && "error" in state ? (typeof state.error === "string" ? state.error : "Validation error") : null;
  const clearError = clearState && "error" in clearState ? (typeof clearState.error === "string" ? clearState.error : "Error") : null;
  const success = state && "success" in state;
  const clearSuccess = clearState && "success" in clearState;

  function onDisplayNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const result = validateWLBrand(e.target.value);
    e.target.setCustomValidity(result.ok ? "" : result.reason);
  }

  function onColorChange(e: React.ChangeEvent<HTMLInputElement>) {
    e.target.setCustomValidity(WL_COLOR_REGEX.test(e.target.value) ? "" : "Must be #RRGGBB format");
  }

  return (
    <div className="space-y-6">
      {currentBranding && (
        <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-200">
          <div style={{ background: currentBranding.brandColor }} className="w-8 h-8 rounded" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={currentBranding.logoUrl} alt="Current logo" className="h-8 w-auto object-contain" />
          <span className="text-sm font-medium">{currentBranding.displayName}</span>
          <form action={clearAction} className="ml-auto">
            <button
              type="submit"
              disabled={clearPending}
              className="text-xs text-red-600 hover:text-red-800 px-3 py-1 border border-red-200 rounded-lg"
            >
              {clearPending ? "Clearing…" : "Clear branding"}
            </button>
          </form>
        </div>
      )}
      {clearError && <p className="text-sm text-red-600">{clearError}</p>}
      {clearSuccess && <p className="text-sm text-green-600">Branding cleared.</p>}

      <form action={formAction} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">
            Logo (PNG / JPG / WebP, max 1 MB)
          </label>
          <input
            ref={inputRef}
            type="file"
            name="logo"
            accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
            required
            className="block w-full text-sm text-gray-600 file:mr-3 file:px-4 file:py-1.5 file:rounded-lg file:border-0 file:bg-gray-100 file:text-gray-700"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Brand Color</label>
          <div className="flex gap-2 items-center">
            <input
              type="color"
              name="brand_color_picker"
              defaultValue={currentBranding?.brandColor ?? "#6366f1"}
              onChange={(e) => {
                const textInput = e.currentTarget.closest("div")?.querySelector<HTMLInputElement>("input[name=brand_color]");
                if (textInput) textInput.value = e.currentTarget.value;
              }}
              className="w-10 h-9 rounded cursor-pointer border border-gray-200"
            />
            <input
              type="text"
              name="brand_color"
              defaultValue={currentBranding?.brandColor ?? "#6366f1"}
              pattern="^#[0-9a-fA-F]{6}$"
              placeholder="#RRGGBB"
              onChange={onColorChange}
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Display Name (2–60 chars)</label>
          <input
            type="text"
            name="display_name"
            defaultValue={currentBranding?.displayName ?? ""}
            minLength={2}
            maxLength={60}
            required
            onChange={onDisplayNameChange}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>

        {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}
        {success && <p className="text-sm text-green-600">Branding saved.</p>}

        <button
          type="submit"
          disabled={pending}
          className="w-full bg-black text-white rounded-xl px-4 py-2.5 text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save branding"}
        </button>
      </form>
    </div>
  );
}
