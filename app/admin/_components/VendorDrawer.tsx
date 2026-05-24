"use client";

import { useState, useTransition } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { VendorRow } from "@/lib/services/admin";

function cents(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n / 100);
}

interface VendorDrawerProps {
  vendors: VendorRow[];
}

interface DrillDownData {
  app_count?: number;
  active_sub_count?: number;
  total_gmv_cents?: number;
  effective_cut_bps?: number;
  cut_bps_override?: number | null;
}

export function VendorTable({ vendors }: VendorDrawerProps) {
  const [selected, setSelected] = useState<VendorRow | null>(null);
  const [drillDown, setDrillDown] = useState<DrillDownData | null>(null);
  const [loading, startTransition] = useTransition();

  function open(vendor: VendorRow) {
    setSelected(vendor);
    setDrillDown(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/vendor-drill-down?id=${vendor.id}`);
      if (res.ok) {
        const data = await res.json();
        setDrillDown(data);
      }
    });
  }

  function dateShort(iso: string) {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <>
      {selected && (
        <Drawer
          open={!!selected}
          onClose={() => setSelected(null)}
          title={selected.display_name ?? selected.id.slice(0, 8)}
        >
          <div className="space-y-5">
            {/* Status */}
            <div className="flex gap-2 flex-wrap">
              <Badge variant={selected.charges_enabled ? "ok" : "bad"}>
                {selected.charges_enabled ? "Charges enabled" : "Charges disabled"}
              </Badge>
              <Badge variant={selected.payouts_enabled ? "ok" : "warn"}>
                {selected.payouts_enabled ? "Payouts enabled" : "Payouts disabled"}
              </Badge>
            </div>

            {/* Key info */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Vendor ID", value: selected.id.slice(0, 12) + "…" },
                { label: "Joined", value: dateShort(selected.created_at) },
                {
                  label: "Connect account",
                  value: selected.stripe_account_id
                    ? selected.stripe_account_id.slice(0, 16) + "…"
                    : "Not connected",
                },
                ...(drillDown
                  ? [
                      { label: "Apps", value: String(drillDown.app_count ?? 0) },
                      { label: "Active subs", value: String(drillDown.active_sub_count ?? 0) },
                      { label: "Total GMV", value: cents(drillDown.total_gmv_cents ?? 0) },
                      {
                        label: "Effective cut",
                        value: `${((drillDown.effective_cut_bps ?? 1200) / 100).toFixed(2)}%${drillDown.cut_bps_override != null ? " (override)" : ""}`,
                      },
                    ]
                  : []),
              ].map(({ label, value }) => (
                <div key={label} className="bg-muted/40 rounded-lg p-3">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
                  <p className="text-sm font-medium mt-0.5 text-foreground break-all">{value}</p>
                </div>
              ))}
            </div>

            {loading && (
              <p className="text-xs text-muted-foreground animate-pulse">Loading stats…</p>
            )}
          </div>
        </Drawer>
      )}

      <div className="overflow-hidden rounded-[10px] border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 text-left">
              {["Name", "Connect", "Charges", "Payouts", "Joined"].map((h) => (
                <th key={h} className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vendors.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No vendors yet.
                </td>
              </tr>
            ) : (
              vendors.map((v) => (
                <tr
                  key={v.id}
                  onClick={() => open(v)}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-foreground">{v.display_name ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
                    {v.stripe_account_id ? v.stripe_account_id.slice(0, 14) + "…" : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={v.charges_enabled ? "text-ok font-semibold" : "text-bad"}>
                      {v.charges_enabled ? "✓" : "✗"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={v.payouts_enabled ? "text-ok font-semibold" : "text-warn"}>
                      {v.payouts_enabled ? "✓" : "✗"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {dateShort(v.created_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
