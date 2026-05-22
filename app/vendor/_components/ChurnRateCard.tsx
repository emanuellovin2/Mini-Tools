export default function ChurnRateCard({
  churnBps,
  trailing3Bps,
}: {
  churnBps: number;
  trailing3Bps: number;
}) {
  const fmt = (bps: number) => (bps / 100).toFixed(1) + "%";

  const delta = churnBps - trailing3Bps;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <p className="text-xs text-gray-500 mb-1">Monthly churn</p>
      <p className="text-3xl font-bold tracking-tight">{fmt(churnBps)}</p>
      <p
        className={`text-xs mt-1 font-medium ${
          delta <= 0 ? "text-green-600" : "text-red-500"
        }`}
      >
        {delta <= 0 ? "↓" : "↑"} vs 3-month avg ({fmt(trailing3Bps)})
      </p>
      <p className="text-xs text-gray-400 mt-3">Logo churn (by subscriber count)</p>
    </div>
  );
}
