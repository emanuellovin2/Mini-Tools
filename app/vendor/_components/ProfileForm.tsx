"use client";

import { useActionState } from "react";
import { updateDisplayNameAction, type ActionResult } from "../actions";

export default function ProfileForm({
  currentDisplayName,
}: {
  currentDisplayName: string;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    updateDisplayNameAction,
    null
  );

  const fieldErrors =
    state && "error" in state && typeof state.error === "object" && state.error !== null
      ? (state.error as Record<string, string[]>)
      : null;

  return (
    <form action={action} className="space-y-3">
      <div>
        <label className="block text-sm text-gray-700 mb-1">Display name</label>
        <input
          name="display_name"
          defaultValue={currentDisplayName}
          placeholder="Your public vendor name"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
        />
        {fieldErrors?.display_name && (
          <p className="text-red-500 text-xs mt-1">{fieldErrors.display_name[0]}</p>
        )}
        {state && "error" in state && typeof state.error === "string" && (
          <p className="text-red-500 text-xs mt-1">{state.error}</p>
        )}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-full bg-black text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
      >
        {pending ? "Saving…" : "Save"}
      </button>

      {state && "success" in state && (
        <p className="text-green-600 text-xs text-center">Display name updated.</p>
      )}
    </form>
  );
}
