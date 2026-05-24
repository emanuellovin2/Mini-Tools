"use client";

import { useState } from "react";
import Link from "next/link";
import type { BuyerSubscription, BuyerInvoice } from "@/lib/services/buyer";
import { formatPrice } from "@/lib/services/apps";
import { Drawer } from "@/components/ui/Drawer";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";

function formatDate(iso: string | number) {
  const d = typeof iso === "number" ? new Date(iso * 1000) : new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ChannelBadge({ sub }: { sub: BuyerSubscription }) {
  if (sub.reseller_id) return <Badge variant="outline">via reseller</Badge>;
  if (sub.affiliate_id) return <Badge variant="outline">via affiliate</Badge>;
  return <Badge variant="outline">Direct</Badge>;
}

function InvoiceList({ customerId }: { customerId: string }) {
  const [invoices, setInvoices] = useState<BuyerInvoice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/buyer/invoices?customerId=${encodeURIComponent(customerId)}`
      );
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      setInvoices(json.invoices ?? []);
      setHasMore(json.hasMore ?? false);
    } catch {
      setInvoices([]);
    } finally {
      setLoading(false);
    }
  }

  if (invoices === null) {
    return (
      <button
        type="button"
        onClick={load}
        className="text-xs text-primary underline mt-1"
      >
        Load invoice history
      </button>
    );
  }

  if (loading) return <Skeleton variant="line" lines={3} />;
  if (invoices.length === 0) return <p className="text-xs text-muted-foreground">No invoices found.</p>;

  return (
    <div className="space-y-2">
      {invoices.map((inv) => (
        <div
          key={inv.id}
          className="flex items-center justify-between gap-3 py-2 border-b border-border/50 last:border-0"
        >
          <div>
            <p className="text-xs font-medium">{formatDate(inv.created)}</p>
            <p className="text-[10px] text-muted-foreground capitalize">{inv.status}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">
              {formatPrice(inv.amount_paid, inv.currency)}
            </span>
            {inv.hosted_invoice_url && (
              <a
                href={inv.hosted_invoice_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-primary underline"
              >
                PDF
              </a>
            )}
          </div>
        </div>
      ))}
      {hasMore && (
        <p className="text-[10px] text-muted-foreground">Showing latest 20 invoices.</p>
      )}
    </div>
  );
}

export function SubDrawer({
  sub,
  trigger,
}: {
  sub: BuyerSubscription;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const isPaused = !!sub.paused_until && new Date(sub.paused_until) > new Date();

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="w-full text-left">
        {trigger}
      </button>

      <Drawer open={open} onClose={() => setOpen(false)} title={sub.app_name}>
        <div className="space-y-5">
          {/* Header */}
          <div className="flex items-start gap-3">
            {sub.app_logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={sub.app_logo_url}
                alt=""
                className="w-12 h-12 rounded-xl object-cover border border-border shrink-0"
              />
            ) : (
              <div className="w-12 h-12 rounded-xl bg-muted shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="font-semibold">{sub.app_name}</p>
              <p className="text-sm text-muted-foreground">
                {sub.formatted_price}/mo
              </p>
              <div className="flex items-center gap-2 mt-1">
                <ChannelBadge sub={sub} />
              </div>
            </div>
          </div>

          {/* Status + dates */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Status</p>
              <p className="font-medium capitalize">
                {isPaused ? "Paused" : sub.status}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Started</p>
              <p className="font-medium">{formatDate(sub.created_at)}</p>
            </div>
            {!sub.cancel_at_period_end && !isPaused && sub.status === "active" && (
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Next charge</p>
                <p className="font-medium">{formatDate(sub.current_period_end)}</p>
              </div>
            )}
            {sub.cancel_at_period_end && (
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Cancels on</p>
                <p className="font-medium text-amber-600">{formatDate(sub.current_period_end)}</p>
              </div>
            )}
            {isPaused && sub.paused_until && (
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Resumes on</p>
                <p className="font-medium text-amber-600">{formatDate(sub.paused_until)}</p>
              </div>
            )}
          </div>

          {/* Invoice history */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Invoice history
            </p>
            <InvoiceList customerId={sub.stripe_customer_id} />
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2 border-t border-border">
            <Link href={`/app/${sub.app_id}`} className="flex-1">
              <Button variant="secondary" size="sm" className="w-full">
                App details
              </Button>
            </Link>
            {(sub.status === "active" || sub.status === "trialing") && (
              <a href={`/api/launch/${sub.app_id}`} className="flex-1">
                <Button size="sm" className="w-full">Launch →</Button>
              </a>
            )}
          </div>
        </div>
      </Drawer>
    </>
  );
}
