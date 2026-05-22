"use client";

import { useActionState } from "react";
import { submitAppAction, type ActionResult } from "../actions";

const inputClass =
  "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black";

function FieldError({ msg }: { msg: string }) {
  return <p className="text-red-500 text-xs mt-1">{msg}</p>;
}

export default function AppForm() {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    submitAppAction,
    null
  );

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
          />
          {fieldErrors?.price_dollars && <FieldError msg={fieldErrors.price_dollars[0]} />}
        </div>
        <div>
          <label className="block text-sm text-gray-700 mb-1">
            Resell floor ($/month)
            <span className="ml-1 text-xs text-gray-400" title="Leave blank to disable resell">
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
