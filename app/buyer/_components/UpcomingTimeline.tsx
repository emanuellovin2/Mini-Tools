"use client";

import type { UpcomingCharge } from "@/lib/services/buyer";
import { formatPrice } from "@/lib/services/apps";

function formatShortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function UpcomingTimeline({ charges }: { charges: UpcomingCharge[] }) {
  if (charges.length === 0) return null;

  const total = charges.reduce((sum, c) => sum + c.price_cents, 0);
  const currency = charges[0]?.currency ?? "usd";

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Upcoming charges · next 30 days
        </h2>
        <span className="text-xs text-muted-foreground">
          Total: <span className="font-medium text-foreground">{formatPrice(total, currency)}</span>
        </span>
      </div>

      <div className="relative">
        {/* Track line */}
        <div className="absolute top-4 left-4 right-4 h-px bg-border" />

        <div className="flex gap-4 overflow-x-auto pb-2 pl-1">
          {charges.map((charge) => (
            <div
              key={charge.subscription_id}
              className="flex flex-col items-center gap-2 shrink-0 min-w-[72px]"
            >
              {/* Dot */}
              <div className="w-2.5 h-2.5 rounded-full bg-primary border-2 border-background ring-2 ring-primary/20 z-10 mt-[11px]" />

              {/* App logo */}
              {charge.app_logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={charge.app_logo_url}
                  alt=""
                  className="w-7 h-7 rounded-md object-cover border border-border"
                />
              ) : (
                <div className="w-7 h-7 rounded-md bg-muted" />
              )}

              <div className="text-center">
                <p className="text-[10px] font-semibold text-foreground leading-tight line-clamp-1 max-w-[72px]">
                  {charge.app_name}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {formatPrice(charge.price_cents, charge.currency)}
                </p>
                <p className="text-[9px] text-muted-foreground/70">
                  {formatShortDate(charge.next_charge_at)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
