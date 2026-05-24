"use client";

import { useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import type { RefundsFeed, RefundEvent } from "@/lib/services/vendor";

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function EventDrawer({ event, onClose }: { event: RefundEvent; onClose: () => void }) {
  return (
    <Drawer
      open
      title={event.type === "refund" ? "Refund detail" : "Dispute adjustment"}
      onClose={onClose}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-muted/40 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">Type</p>
            <Badge variant={event.type === "refund" ? "warn" : "bad"}>
              {event.type === "refund" ? "Refund" : "Dispute"}
            </Badge>
          </div>
          <div className="bg-muted/40 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">Amount</p>
            <p className="text-lg font-semibold">{formatCents(event.amount_cents)}</p>
          </div>
        </div>

        <div className="space-y-2 text-[13px]">
          <div className="flex justify-between py-1 border-b border-border-soft">
            <span className="text-muted-foreground">Date</span>
            <span>{formatDate(event.date)}</span>
          </div>
          <div className="flex justify-between py-1 border-b border-border-soft">
            <span className="text-muted-foreground">Stripe ID</span>
            <span className="font-mono text-[12px]">{event.id}</span>
          </div>
          <div className="flex justify-between py-1">
            <span className="text-muted-foreground">Description</span>
            <span className="text-right max-w-[200px]">{event.description}</span>
          </div>
        </div>

        {event.type === "refund" && (
          <div className="bg-muted/40 rounded-lg p-3 text-[12px] text-muted-foreground">
            Voluntary refunds reverse only your transfer. Platform and affiliate/reseller shares are non-refundable per platform policy.
          </div>
        )}
        {event.type === "dispute" && (
          <div className="bg-bad-soft rounded-lg p-3 text-[12px] text-bad">
            Lost disputes reverse all transfers for this invoice — vendor, platform, and affiliate/reseller shares.
          </div>
        )}
      </div>
    </Drawer>
  );
}

export default function RefundsFeedCard({ feed }: { feed: RefundsFeed }) {
  const [selected, setSelected] = useState<RefundEvent | null>(null);

  return (
    <>
      <div className="space-y-3">
        {(feed.refund_count > 0 || feed.dispute_count > 0) && (
          <div className="flex items-center gap-4 text-[13px] flex-wrap">
            {feed.refund_count > 0 && (
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">{feed.refund_count}</span> refund{feed.refund_count !== 1 ? "s" : ""} ({formatCents(feed.refund_cents)})
              </span>
            )}
            {feed.dispute_count > 0 && (
              <span className="text-bad font-medium">
                {feed.dispute_count} dispute{feed.dispute_count !== 1 ? "s" : ""} ({formatCents(feed.dispute_cents)})
              </span>
            )}
          </div>
        )}

        <DenseTable
          cols={["Date", "Type", "Amount", "Description"]}
          empty={
            <EmptyState
              title="No refunds or disputes"
              body="No activity in the selected period."
              cta={<span className="text-[12px] text-muted-foreground">Keep it up.</span>}
            />
          }
        >
          {feed.events.map((event) => (
            <DenseRow key={event.id} cols={4} onClick={() => setSelected(event)}>
              <DenseCell className="text-muted-foreground">{formatDate(event.date)}</DenseCell>
              <DenseCell>
                <Badge variant={event.type === "refund" ? "warn" : "bad"}>
                  {event.type}
                </Badge>
              </DenseCell>
              <DenseCell align="right">{formatCents(event.amount_cents)}</DenseCell>
              <DenseCell className="text-muted-foreground truncate">{event.description}</DenseCell>
            </DenseRow>
          ))}
        </DenseTable>
      </div>

      {selected && <EventDrawer event={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
