"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { forceRefundAuditAction } from "@/app/admin/actions";
import type { SubDetail } from "@/lib/services/admin";

function cents(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n / 100);
}

function dateShort(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_VARIANT: Record<string, "ok" | "warn" | "bad" | "secondary"> = {
  active: "ok",
  trialing: "ok",
  past_due: "bad",
  canceled: "secondary",
  incomplete: "warn",
};

export function SubLookupTool() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SubDetail | null | "not_found">(null);
  const [loading, startTransition] = useTransition();
  const [refundReason, setRefundReason] = useState("");
  const [refundMsg, setRefundMsg] = useState("");

  function lookup(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setResult(null);
    setRefundMsg("");
    startTransition(async () => {
      const res = await fetch(`/api/admin/sub-lookup?id=${encodeURIComponent(query.trim())}`);
      if (res.status === 404) { setResult("not_found"); return; }
      if (!res.ok) { setResult("not_found"); return; }
      setResult(await res.json());
    });
  }

  function requestRefund() {
    if (!result || result === "not_found") return;
    startTransition(async () => {
      const res = await forceRefundAuditAction({ subscriptionId: result.id, reason: refundReason });
      if ("error" in res) {
        setRefundMsg("Error: " + res.error);
      } else {
        setRefundMsg(res.message ?? "Logged.");
        setRefundReason("");
      }
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={lookup} className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Subscription ID (uuid)"
          className="flex-1 border border-border rounded-lg px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <Button type="submit" size="sm" disabled={loading}>
          {loading ? "Looking up…" : "Lookup"}
        </Button>
      </form>

      {result === "not_found" && (
        <p className="text-sm text-bad">No subscription found for that ID.</p>
      )}

      {result && result !== "not_found" && (
        <div className="border border-border rounded-[10px] p-4 space-y-4 bg-surface">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-foreground">{result.app_name}</p>
              <p className="text-xs text-muted-foreground font-mono">{result.id}</p>
            </div>
            <Badge variant={STATUS_VARIANT[result.status] ?? "secondary"}>{result.status}</Badge>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            {[
              { label: "Price", value: result.formatted_price + "/mo" },
              { label: "Period end", value: dateShort(result.current_period_end) },
              { label: "Created", value: dateShort(result.created_at) },
              { label: "Buyer ID", value: result.buyer_id.slice(0, 12) + "…" },
              { label: "Stripe sub", value: result.stripe_subscription_id.slice(0, 20) + "…" },
              { label: "Channel", value: result.reseller_id ? "Reseller" : result.affiliate_id ? "Affiliate" : "Direct" },
            ].map(({ label, value }) => (
              <div key={label}>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
                <p className="text-sm font-mono text-foreground">{value}</p>
              </div>
            ))}
          </div>

          <div className="border-t border-border pt-4 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Request refund</p>
            <textarea
              rows={2}
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              placeholder="Reason (min 10 chars)"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                disabled={loading || refundReason.trim().length < 10}
                onClick={requestRefund}
              >
                Log refund request
              </Button>
              {refundMsg && <span className="text-xs text-muted-foreground">{refundMsg}</span>}
            </div>
            <p className="text-xs text-muted-foreground">Logs to audit trail; process the actual refund via Stripe Dashboard.</p>
          </div>
        </div>
      )}
    </div>
  );
}
