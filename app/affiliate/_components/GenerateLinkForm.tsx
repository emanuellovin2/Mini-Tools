"use client";

import { useState, useTransition } from "react";
import { createAffiliateLinkAction } from "../actions";

export default function GenerateLinkForm() {
  const [result, setResult] = useState<{ code: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

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
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div>
          <label className="block text-xs text-gray-700 mb-1">
            App ID (optional — leave blank for a generic link)
          </label>
          <input
            name="app_id"
            type="text"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-black"
          />
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
