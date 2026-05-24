"use client";

import { useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { EmptyState } from "@/components/ui/EmptyState";
import type { DunningResult, DunningItem } from "@/lib/services/vendor";

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function ItemDrawer({ item, onClose }: { item: DunningItem; onClose: () => void }) {
  return (
    <Drawer open title={`Dunning — ${item.app_name}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-muted/40 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">At risk</p>
            <p className="text-lg font-semibold">{formatCents(item.price_cents)}/mo</p>
          </div>
          <div className="bg-muted/40 rounded-lg p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">Period ended</p>
            <p className="text-lg font-semibold">{timeAgo(item.current_period_end)}</p>
          </div>
        </div>

        <div className="space-y-2 text-[13px]">
          <div className="flex justify-between py-1 border-b border-border-soft">
            <span className="text-muted-foreground">Anon subscriber</span>
            <span className="font-mono text-[12px]">{item.anon_user_id.slice(0, 12)}…</span>
          </div>
          <div className="flex justify-between py-1 border-b border-border-soft">
            <span className="text-muted-foreground">Stripe sub ID</span>
            <span className="font-mono text-[12px]">{item.stripe_subscription_id}</span>
          </div>
          <div className="flex justify-between py-1">
            <span className="text-muted-foreground">App</span>
            <span>{item.app_name}</span>
          </div>
        </div>

        <div className="bg-warn-soft rounded-lg p-3 text-[12px] text-warn">
          Stripe retries failed payments up to 4 times over ~2 weeks (Smart Retries). After that, the subscription cancels automatically.
        </div>
      </div>
    </Drawer>
  );
}

export default function DunningQueueCard({ dunning }: { dunning: DunningResult }) {
  const [selected, setSelected] = useState<DunningItem | null>(null);

  return (
    <>
      <div className="space-y-3">
        {dunning.count > 0 && (
          <div className="flex items-center gap-3 text-[13px]">
            <span className="inline-flex items-center gap-1.5 text-warn font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-warn" />
              {dunning.count} subscription{dunning.count !== 1 ? "s" : ""} past due
            </span>
            <span className="text-muted-foreground">{formatCents(dunning.at_risk_cents)}/mo at risk</span>
          </div>
        )}

        <DenseTable
          cols={["Subscriber", "App", "Amount", "Period end"]}
          empty={
            <EmptyState
              title="No payment failures"
              body="All subscriptions are current."
              cta={<span className="text-[12px] text-muted-foreground">Nothing to do here.</span>}
            />
          }
        >
          {dunning.items.map((item) => (
            <DenseRow key={item.id} cols={4} onClick={() => setSelected(item)}>
              <DenseCell>
                <span className="font-mono text-[12px]">{item.anon_user_id.slice(0, 10)}…</span>
              </DenseCell>
              <DenseCell>{item.app_name}</DenseCell>
              <DenseCell align="right">{formatCents(item.price_cents)}</DenseCell>
              <DenseCell align="right" className="text-muted-foreground">
                {timeAgo(item.current_period_end)}
              </DenseCell>
            </DenseRow>
          ))}
        </DenseTable>
      </div>

      {selected && <ItemDrawer item={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
