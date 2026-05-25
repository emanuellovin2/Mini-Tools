"use client";

import { useState } from "react";
import type { ClientHealthScore } from "@/lib/services/agency";
import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function riskVariant(risk: "low" | "medium" | "high"): "ok" | "warn" | "bad" {
  return risk === "low" ? "ok" : risk === "medium" ? "warn" : "bad";
}

function ScoreBar({ score }: { score: number }) {
  const color = score >= 70 ? "bg-ok" : score >= 40 ? "bg-warn" : "bg-bad";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-[12px] tabular-nums font-medium text-foreground w-6 text-right">
        {score}
      </span>
    </div>
  );
}

export default function ClientHealthBoard({
  initialItems,
  initialCursor,
}: {
  initialItems: ClientHealthScore[];
  initialCursor: string | null;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ cursor, limit: "25" });
      const res = await fetch(`/api/agency/clients?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json() as { items: ClientHealthScore[]; next_cursor: string | null };
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.next_cursor);
    } catch {
      // silent — user can retry
    } finally {
      setLoading(false);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No clients yet"
        body="Invite your first client to start tracking health scores."
      />
    );
  }

  return (
    <div className="space-y-3">
      <DenseTable
        cols={["Client", "Health", "Risk", "Deployments", "Activity", "Credits"]}
      >
        {items.map((row) => (
          <DenseRow key={row.client_org_id}>
            <DenseCell>
              <span className="font-medium text-foreground">{row.client_name}</span>
              {row.client_slug && (
                <span className="text-muted-foreground ml-1.5 text-[11px]">
                  @{row.client_slug}
                </span>
              )}
            </DenseCell>
            <DenseCell>
              <ScoreBar score={row.score} />
            </DenseCell>
            <DenseCell>
              <Badge variant={riskVariant(row.churn_risk)}>
                {row.churn_risk}
              </Badge>
            </DenseCell>
            <DenseCell>
              <span className="text-foreground tabular-nums">{row.active_deployments}</span>
              {row.failed_deployments > 0 && (
                <span className="text-bad ml-1.5 text-[11px]">
                  {row.failed_deployments} failed
                </span>
              )}
              {row.orphaned_deployments > 0 && (
                <span className="text-warn ml-1.5 text-[11px]">
                  {row.orphaned_deployments} orphaned
                </span>
              )}
            </DenseCell>
            <DenseCell>
              <span className="text-muted-foreground text-[12px]">
                {fmtDate(row.last_activity_at)}
              </span>
            </DenseCell>
            <DenseCell align="right">
              <span className="tabular-nums text-[12px] text-foreground">
                {fmt(row.credits_remaining_cents)}
              </span>
            </DenseCell>
          </DenseRow>
        ))}
      </DenseTable>

      {cursor && (
        <div className="flex justify-center pt-1">
          <button
            onClick={loadMore}
            disabled={loading}
            className="text-[12px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
