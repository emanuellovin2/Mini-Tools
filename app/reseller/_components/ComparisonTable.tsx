"use client";

import { useState } from "react";

export type ComparisonRow = {
  offer_id: string;
  offer_slug: string;
  app_name: string;
  floor_cents: number;
  price_cents: number;
  margin_cents: number;
  mrr_cents: number;
  active_subs: number;
  churn_rate_pct: number;
  status: string;
};

type SortKey = keyof ComparisonRow;

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(cents / 100);
}

function exportCsv(rows: ComparisonRow[]) {
  const headers = ["App", "Offer slug", "Floor", "Your price", "Margin", "MRR", "Active buyers", "Churn %", "Status"];
  const lines = rows.map((r) => [
    `"${r.app_name}"`,
    r.offer_slug,
    (r.floor_cents / 100).toFixed(2),
    (r.price_cents / 100).toFixed(2),
    (r.margin_cents / 100).toFixed(2),
    (r.mrr_cents / 100).toFixed(2),
    r.active_subs,
    r.churn_rate_pct.toFixed(1),
    r.status,
  ].join(","));
  const csv = [headers.join(","), ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "offers-comparison.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export default function ComparisonTable({ rows }: { rows: ComparisonRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("mrr_cents");
  const [desc, setDesc] = useState(true);

  if (rows.length === 0) {
    return <p className="text-[13px] text-muted-foreground text-center py-8">No offers yet. Create an offer from the Discover tab.</p>;
  }

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return desc ? -cmp : cmp;
  });

  function toggleSort(key: SortKey) {
    if (key === sortKey) setDesc((d) => !d);
    else { setSortKey(key); setDesc(true); }
  }

  function Th({ k, label }: { k: SortKey; label: string }) {
    const active = k === sortKey;
    return (
      <th
        className="text-left px-3 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap"
        onClick={() => toggleSort(k)}
      >
        {label}
        {active && <span className="ml-1">{desc ? "↓" : "↑"}</span>}
      </th>
    );
  }

  const STATUS_CHIP: Record<string, string> = {
    active: "bg-ok-soft text-ok",
    paused: "bg-warn-soft text-warn",
    draft: "bg-muted text-muted-foreground",
  };

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button
          onClick={() => exportCsv(rows)}
          className="text-[12px] px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
        >
          Export CSV ↓
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-border">
              <Th k="app_name" label="App" />
              <Th k="offer_slug" label="Slug" />
              <Th k="floor_cents" label="Floor" />
              <Th k="price_cents" label="Your price" />
              <Th k="margin_cents" label="Margin" />
              <Th k="mrr_cents" label="MRR" />
              <Th k="active_subs" label="Buyers" />
              <Th k="churn_rate_pct" label="Churn %" />
              <Th k="status" label="Status" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.offer_id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                <td className="px-3 py-2 font-medium text-foreground">{r.app_name}</td>
                <td className="px-3 py-2 text-muted-foreground font-mono">/{r.offer_slug}</td>
                <td className="px-3 py-2 tabular-nums">{fmt(r.floor_cents)}</td>
                <td className="px-3 py-2 tabular-nums">{fmt(r.price_cents)}</td>
                <td className="px-3 py-2 tabular-nums text-ok">{fmt(r.margin_cents)}</td>
                <td className="px-3 py-2 tabular-nums font-semibold">{fmt(r.mrr_cents)}</td>
                <td className="px-3 py-2 tabular-nums">{r.active_subs}</td>
                <td className="px-3 py-2 tabular-nums">{r.churn_rate_pct.toFixed(1)}%</td>
                <td className="px-3 py-2">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_CHIP[r.status] ?? "bg-muted text-muted-foreground"}`}>
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
