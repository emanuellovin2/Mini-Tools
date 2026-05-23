import type { Metadata } from "next";
import Link from "next/link";
import { getLeaderboard, getLeaderboardByLifetime } from "@/lib/services/affiliate";

export const metadata: Metadata = { title: "Affiliate Leaderboard — [PLATFORM]" };

// Round MRR to nearest $100 for public display (prevents back-calculating sub counts).
function roundMrr(cents: number): string {
  if (cents <= 0) return "$0";
  const dollars = cents / 100;
  if (dollars < 100) return "<$100";
  const rounded = Math.round(dollars / 100) * 100;
  if (rounded >= 1_000) return `$${(rounded / 1_000).toFixed(rounded % 1_000 === 0 ? 0 : 1)}k`;
  return `$${rounded}`;
}

type Sort = "active" | "lifetime";

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  const { sort: sortParam } = await searchParams;
  const sort: Sort = sortParam === "lifetime" ? "lifetime" : "active";

  const rows = sort === "lifetime"
    ? await getLeaderboardByLifetime(50)
    : await getLeaderboard(50);

  return (
    <main className="max-w-3xl mx-auto px-4 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Affiliate Leaderboard</h1>
        <p className="text-sm text-gray-500 mt-1">Top affiliates by revenue generated. MRR is rounded for privacy.</p>
      </div>

      <div className="flex gap-2 text-sm">
        <Link
          href="/affiliates/top?sort=active"
          className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
            sort === "active"
              ? "bg-gray-900 text-white"
              : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          Active MRR
        </Link>
        <Link
          href="/affiliates/top?sort=lifetime"
          className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
            sort === "lifetime"
              ? "bg-gray-900 text-white"
              : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          Lifetime MRR
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No affiliates on the leaderboard yet.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-400 border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium">#</th>
                <th className="text-left px-4 py-3 font-medium">Affiliate</th>
                <th className="text-right px-4 py-3 font-medium">Active MRR</th>
                <th className="text-right px-4 py-3 font-medium">Lifetime MRR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map((row) => {
                const rank = sort === "active" ? row.active_rank : row.lifetime_rank;
                return (
                  <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-gray-400 font-mono text-xs">{rank}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/affiliates/${row.slug}`}
                        className="font-medium text-gray-900 hover:text-blue-600 transition-colors"
                      >
                        {row.display_name ?? row.slug}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {roundMrr(row.affiliate_active_mrr_cents)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {roundMrr(row.affiliate_lifetime_mrr_cents)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400 text-center">
        Only affiliates who have opted into a public profile appear here.{" "}
        <Link href="/affiliate" className="underline">Manage your profile</Link>
      </p>
    </main>
  );
}
