"use client";

import { useState, useTransition } from "react";
import { setVendorCutOverrideAction } from "@/app/admin/actions";
import type { VendorCutInfo } from "@/lib/services/admin";

function bpsToPercent(bps: number) {
  return (bps / 100).toFixed(2) + "%";
}

function tierLabel(bps: number) {
  if (bps <= 300) return "Tier 4";
  if (bps <= 500) return "Tier 3";
  if (bps <= 800) return "Tier 2";
  return "Tier 1";
}

function OverrideModal({
  vendor,
  onClose,
}: {
  vendor: VendorCutInfo;
  onClose: () => void;
}) {
  const [bpsInput, setBpsInput] = useState(
    vendor.cut_bps_override != null ? String(vendor.cut_bps_override) : ""
  );
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  const bpsValue = bpsInput === "" ? null : Number(bpsInput);
  const percentDisplay =
    bpsValue != null && !Number.isNaN(bpsValue)
      ? ` (${bpsToPercent(bpsValue)})`
      : "";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (bpsValue !== null && (bpsValue < 0 || bpsValue > 5000)) {
      setError("bps must be 0–5000");
      return;
    }
    if (reason.trim().length < 10) {
      setError("Reason must be at least 10 characters");
      return;
    }

    startTransition(async () => {
      const result = await setVendorCutOverrideAction({
        vendorId: vendor.vendor_id,
        newBps: bpsValue,
        reason: reason.trim(),
      });
      if ("error" in result) {
        setError(result.error);
      } else {
        onClose();
      }
    });
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md">
        <h3 className="font-semibold text-lg mb-1">
          Set commission override
        </h3>
        <p className="text-sm text-gray-700 mb-4">
          Vendor:{" "}
          <span className="font-medium text-gray-700">
            {vendor.display_name ?? vendor.vendor_id.slice(0, 8)}
          </span>
          {" — "}current effective:{" "}
          <span className="font-medium">{bpsToPercent(vendor.effective_cut_bps)}</span>
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Override (bps){percentDisplay}
            </label>
            <input
              type="number"
              min={0}
              max={5000}
              placeholder="Leave blank to clear override"
              value={bpsInput}
              onChange={(e) => setBpsInput(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
            <p className="text-xs text-gray-700 mt-1">
              0 = free; 1200 = 12% (Tier 1 default); max 5000 (50%)
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Reason (required, ≥10 chars)
            </label>
            <textarea
              required
              minLength={10}
              maxLength={500}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Launch partner contract Q2 2026"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 resize-none"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              {isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function VendorCutOverrideTable({
  vendors,
}: {
  vendors: VendorCutInfo[];
}) {
  const [editing, setEditing] = useState<VendorCutInfo | null>(null);

  if (vendors.length === 0) {
    return (
      <p className="text-sm text-gray-700 border border-dashed border-gray-200 rounded-xl p-6 text-center">
        No vendors yet.
      </p>
    );
  }

  return (
    <>
      {editing && (
        <OverrideModal vendor={editing} onClose={() => setEditing(null)} />
      )}
      <div className="border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-4 py-2 font-medium text-gray-700">Vendor</th>
              <th className="px-4 py-2 font-medium text-gray-700">Auto-tier cut</th>
              <th className="px-4 py-2 font-medium text-gray-700">Override</th>
              <th className="px-4 py-2 font-medium text-gray-700">Effective</th>
              <th className="px-4 py-2 font-medium text-gray-700">Action</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((v) => (
              <tr key={v.vendor_id} className="border-t border-gray-100">
                <td className="px-4 py-3 font-medium">
                  {v.display_name ?? v.vendor_id.slice(0, 8)}
                </td>
                <td className="px-4 py-3 text-gray-700">
                  {bpsToPercent(v.auto_tier_cut_bps)}{" "}
                  <span className="text-xs text-gray-700">
                    ({tierLabel(v.auto_tier_cut_bps)})
                  </span>
                </td>
                <td className="px-4 py-3">
                  {v.cut_bps_override != null ? (
                    <span className="text-xs px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200 font-medium">
                      {bpsToPercent(v.cut_bps_override)}
                    </span>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </td>
                <td className="px-4 py-3 font-semibold">
                  {bpsToPercent(v.effective_cut_bps)}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => setEditing(v)}
                    className="text-xs text-blue-600 hover:text-blue-800 transition-colors"
                  >
                    {v.cut_bps_override != null ? "Edit / Clear" : "Set override"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
