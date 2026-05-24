import type { CohortRow } from "@/lib/services/vendor";

function pct(retained: number, total: number) {
  if (total === 0) return null;
  return Math.round((retained / total) * 100);
}

function heatColor(p: number | null): string {
  if (p === null) return "bg-gray-50 text-gray-600";
  if (p >= 90) return "bg-green-100 text-green-800";
  if (p >= 70) return "bg-lime-100 text-lime-800";
  if (p >= 50) return "bg-yellow-100 text-yellow-800";
  if (p >= 30) return "bg-orange-100 text-orange-800";
  return "bg-red-100 text-red-700";
}

export default function CohortRetentionTable({ rows }: { rows: CohortRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-gray-700 py-4">
        Not enough data for cohort analysis yet. Needs at least 2 months of payment history.
      </p>
    );
  }

  // Group rows by cohort_month
  const cohortMap = new Map<string, Map<number, CohortRow>>();
  for (const row of rows) {
    if (!cohortMap.has(row.cohort_month)) cohortMap.set(row.cohort_month, new Map());
    cohortMap.get(row.cohort_month)!.set(row.month_offset, row);
  }
  const cohorts = Array.from(cohortMap.keys()).sort();
  const maxOffset = Math.max(...rows.map((r) => r.month_offset));

  return (
    <div className="overflow-x-auto">
      <table className="text-xs min-w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="text-left text-gray-700 font-medium pb-2 pr-3 whitespace-nowrap">
              Cohort
            </th>
            <th className="text-right text-gray-700 font-medium pb-2 px-2 whitespace-nowrap">
              Size
            </th>
            {Array.from({ length: maxOffset + 1 }, (_, i) => (
              <th
                key={i}
                className="text-center text-gray-700 font-medium pb-2 px-1 whitespace-nowrap"
              >
                M{i}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => {
            const offsets = cohortMap.get(cohort)!;
            const sizeRow = offsets.get(0);
            const size = sizeRow?.cohort_size ?? 0;
            return (
              <tr key={cohort}>
                <td className="pr-3 py-1 text-gray-600 whitespace-nowrap">
                  {cohort.slice(0, 7)}
                </td>
                <td className="px-2 py-1 text-right text-gray-700">{size}</td>
                {Array.from({ length: maxOffset + 1 }, (_, i) => {
                  const row = offsets.get(i);
                  const p = row ? pct(row.retained_count, row.cohort_size) : null;
                  return (
                    <td
                      key={i}
                      className={`px-1 py-1 text-center rounded font-medium ${heatColor(p)}`}
                    >
                      {p !== null ? `${p}%` : "—"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
