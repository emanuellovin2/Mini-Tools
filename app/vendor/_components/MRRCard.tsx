import type { MRRSnapshot, MRRWaterfallRow } from "@/lib/services/vendor";

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

export default function MRRCard({
  snapshot,
  waterfall,
}: {
  snapshot: MRRSnapshot;
  waterfall: MRRWaterfallRow[];
}) {
  const prev = waterfall.length >= 2 ? waterfall[waterfall.length - 2] : null;
  const deltaCents = prev
    ? snapshot.mrr_cents - prev.end_mrr_cents
    : null;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <p className="text-xs text-gray-700 mb-1">MRR</p>
      <p className="text-3xl font-bold tracking-tight">
        {formatCents(snapshot.mrr_cents)}
      </p>
      {deltaCents !== null && (
        <p
          className={`text-xs mt-1 font-medium ${
            deltaCents >= 0 ? "text-green-600" : "text-red-500"
          }`}
        >
          {deltaCents >= 0 ? "+" : ""}
          {formatCents(deltaCents)} vs last month
        </p>
      )}
      <div className="mt-4 grid grid-cols-2 gap-3 text-center">
        <div className="bg-gray-50 rounded-xl p-3">
          <p className="text-xs text-gray-700">Active subs</p>
          <p className="text-xl font-semibold mt-0.5">{snapshot.active_subs}</p>
        </div>
        <div className="bg-gray-50 rounded-xl p-3">
          <p className="text-xs text-gray-700">ARPU</p>
          <p className="text-xl font-semibold mt-0.5">
            {formatCents(snapshot.arpu_cents)}
          </p>
        </div>
      </div>
    </div>
  );
}
