"use client";

type Link = {
  id: string;
  code: string;
  app_id: string | null;
  created_at: string;
};

export default function LinksList({ links, appUrl }: { links: Link[]; appUrl: string }) {
  async function copy(url: string) {
    await navigator.clipboard.writeText(url);
  }

  if (links.length === 0) {
    return (
      <p className="text-sm text-gray-700 text-center py-8">
        No links yet — generate your first referral link above.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-gray-100">
      {links.map((link) => {
        const url = `${appUrl}/marketplace?aff=${link.code}`;
        return (
          <li key={link.id} className="py-3 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-xs text-gray-700 truncate">{url}</p>
              <p className="text-xs text-gray-700 mt-0.5">
                {link.app_id ? `App: ${link.app_id}` : "Generic (all apps)"}
                {" · "}
                {new Date(link.created_at).toLocaleDateString()}
              </p>
            </div>
            <button
              onClick={() => copy(url)}
              className="shrink-0 text-xs text-black underline"
            >
              Copy
            </button>
          </li>
        );
      })}
    </ul>
  );
}
