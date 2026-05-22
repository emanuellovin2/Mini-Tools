"use client";

import { useActionState, useTransition } from "react";
import { setupResellerSlugAction } from "@/app/reseller/actions";
import type { ActionResult } from "@/app/reseller/actions";

interface Props {
  currentSlug: string | null;
  hasActiveSub: boolean;
  userId: string;
}

export default function SetupForm({ currentSlug, hasActiveSub }: Props) {
  const [result, dispatch] = useActionState<ActionResult | null, FormData>(
    setupResellerSlugAction,
    null
  );
  const [pending, startTransition] = useTransition();

  async function startSubscription() {
    const res = await fetch("/api/reseller/setup", { method: "POST" });
    if (res.ok) {
      const { url } = await res.json();
      window.location.href = url;
    }
  }

  const slugSaved = currentSlug || (result && "success" in result && result.success);
  const slugErrors =
    result && "error" in result && typeof result.error === "object"
      ? (result.error as Record<string, string[]>)
      : null;
  const topError =
    result && "error" in result && typeof result.error === "string" ? result.error : null;

  return (
    <div className="space-y-6">
      {/* Step 1: Slug */}
      <div>
        <p className="text-sm font-medium mb-1">
          Step 1: Choose your storefront slug{" "}
          {slugSaved && <span className="text-green-600">✓ Saved</span>}
        </p>
        {!slugSaved ? (
          <form
            action={(fd) => startTransition(() => { dispatch(fd); })}
            className="flex gap-2"
          >
            <div className="flex-1">
              <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden text-sm">
                <span className="px-3 py-2 bg-gray-50 text-gray-400 border-r border-gray-300 shrink-0">
                  /r/
                </span>
                <input
                  name="slug"
                  type="text"
                  placeholder="your-store"
                  className="flex-1 px-3 py-2 focus:outline-none"
                />
              </div>
              {slugErrors?.slug && (
                <p className="text-red-600 text-xs mt-1">{slugErrors.slug[0]}</p>
              )}
              {topError && <p className="text-red-600 text-xs mt-1">{topError}</p>}
              <p className="text-xs text-gray-400 mt-1">
                Lowercase letters, numbers, hyphens. 3–40 chars.
              </p>
            </div>
            <button
              type="submit"
              disabled={pending}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 shrink-0"
            >
              Save
            </button>
          </form>
        ) : (
          <p className="text-sm text-gray-700">
            Your storefront:{" "}
            <span className="font-mono bg-gray-100 px-2 py-0.5 rounded">/r/{currentSlug}</span>
          </p>
        )}
      </div>

      {/* Step 2: Subscribe */}
      <div>
        <p className="text-sm font-medium mb-1">
          Step 2: Subscribe to the reseller plan ($19/mo){" "}
          {hasActiveSub && <span className="text-green-600">✓ Active</span>}
        </p>
        {!hasActiveSub ? (
          <button
            onClick={startSubscription}
            disabled={!slugSaved}
            className="w-full py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Subscribe for $19/mo
          </button>
        ) : (
          <p className="text-sm text-gray-500">Your reseller subscription is active.</p>
        )}
        {!slugSaved && (
          <p className="text-xs text-gray-400 mt-1">Save your slug first to enable payment.</p>
        )}
      </div>
    </div>
  );
}
