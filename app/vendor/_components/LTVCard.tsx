import type { LTVResult } from "@/lib/services/vendor";

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

export default function LTVCard({ ltv }: { ltv: LTVResult }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <p className="text-xs text-gray-500 mb-1">Est. LTV</p>
      <p className="text-3xl font-bold tracking-tight">
        {ltv.avg_ltv_cents > 0 ? formatCents(ltv.avg_ltv_cents) : "—"}
      </p>
      {ltv.data_sparse && (
        <p className="text-xs text-amber-600 mt-1 font-medium">
          ⚠ Less than 6 months of data — estimate may be unreliable
        </p>
      )}
      <p className="text-xs text-gray-400 mt-3">
        Method: {ltv.method}
      </p>
    </div>
  );
}
