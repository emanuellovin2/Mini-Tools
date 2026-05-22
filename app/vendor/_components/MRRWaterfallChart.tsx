"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import type { MRRWaterfallRow } from "@/lib/services/vendor";

function formatDollars(cents: number) {
  if (cents >= 100000) return `$${(cents / 100000).toFixed(1)}k`;
  return `$${(cents / 100).toFixed(0)}`;
}

export default function MRRWaterfallChart({
  data,
}: {
  data: MRRWaterfallRow[];
}) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-gray-400">
        No revenue data yet
      </div>
    );
  }

  const chartData = data.map((row) => ({
    month: row.month,
    "New MRR": row.new_mrr_cents / 100,
    "Churned MRR": row.churned_mrr_cents / 100,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis
          tick={{ fontSize: 11 }}
          tickFormatter={(v: number) => formatDollars(v * 100)}
          width={50}
        />
        <Tooltip
          formatter={(value) =>
            new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
              minimumFractionDigits: 0,
            }).format(Number(value))
          }
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="New MRR" fill="#22c55e" radius={[3, 3, 0, 0]} />
        <Bar dataKey="Churned MRR" fill="#f87171" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
