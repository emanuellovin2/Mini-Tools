"use client";

import { useTransition, useState } from "react";
import { updateAffiliateProfileAction } from "../actions";

type Props = {
  currentSlug: string | null;
  currentBio: string | null;
  currentAvatarUrl: string | null;
};

const SLUG_PATTERN = /^[a-z0-9-]{3,40}$/;

export default function ProfileEditor({ currentSlug, currentBio, currentAvatarUrl }: Props) {
  const [isPending, startTransition] = useTransition();
  const [slug, setSlug] = useState(currentSlug ?? "");
  const [bio, setBio] = useState(currentBio ?? "");
  const [avatarUrl, setAvatarUrl] = useState(currentAvatarUrl ?? "");
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [showPublic, setShowPublic] = useState(!!currentSlug);

  const slugError = slug && !SLUG_PATTERN.test(slug)
    ? "3–40 chars, lowercase letters, numbers, hyphens only"
    : null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (slugError) return;

    const fd = new FormData();
    fd.set("slug", showPublic ? slug : "");
    fd.set("bio", bio);
    fd.set("avatar_url", avatarUrl);

    startTransition(async () => {
      const result = await updateAffiliateProfileAction(fd);
      if ("error" in result) {
        setMessage({ type: "error", text: result.error });
      } else {
        setMessage({ type: "ok", text: "Profile saved." });
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
      <h2 className="text-sm font-semibold text-gray-700">Public Profile</h2>

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={showPublic}
          onChange={(e) => setShowPublic(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />
        <span className="text-sm text-gray-700">Appear on public leaderboard</span>
      </label>

      {showPublic && (
        <>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Profile slug <span className="text-gray-400">(becomes /affiliates/your-slug)</span>
            </label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="your-slug"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            {slugError && <p className="text-xs text-red-500 mt-1">{slugError}</p>}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Bio</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Tell potential buyers about yourself…"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none"
            />
            <p className="text-xs text-gray-400 text-right">{bio.length}/500</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Avatar URL</label>
            <input
              type="url"
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="https://…"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>
        </>
      )}

      {message && (
        <p className={`text-xs font-medium ${message.type === "ok" ? "text-green-600" : "text-red-600"}`}>
          {message.text}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending || !!slugError}
        className="bg-gray-900 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
      >
        {isPending ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}
