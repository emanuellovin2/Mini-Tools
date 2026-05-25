import type { AgencyBalance, AgencyPayout } from "@/lib/services/agency";
import { Badge } from "@/components/ui/Badge";

function fmt(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function AgencyBalanceCard({
  balance,
  payouts,
}: {
  balance: AgencyBalance;
  payouts: AgencyPayout[];
}) {
  if (!balance.connected) {
    return (
      <div className="rounded-[10px] border border-border p-4 bg-surface shadow-[var(--shadow-card)]">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
          Stripe Connect
        </p>
        <p className="text-[13px] text-muted-foreground">
          Connect your Stripe account to receive agency payouts.
        </p>
      </div>
    );
  }

  const statusVariant = balance.charges_enabled && balance.payouts_enabled
    ? "ok"
    : balance.charges_enabled
    ? "warn"
    : "bad";

  const statusLabel = balance.charges_enabled && balance.payouts_enabled
    ? "Active"
    : balance.charges_enabled
    ? "Payouts pending"
    : "KYC required";

  return (
    <div className="rounded-[10px] border border-border p-4 bg-surface shadow-[var(--shadow-card)] space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          Stripe Connect
        </p>
        <Badge variant={statusVariant}>{statusLabel}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">Available</p>
          <p className="text-[20px] font-semibold tabular-nums text-foreground">
            {fmt(balance.available_cents, balance.currency)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-0.5">Pending</p>
          <p className="text-[20px] font-semibold tabular-nums text-foreground">
            {fmt(balance.pending_cents, balance.currency)}
          </p>
        </div>
      </div>

      {payouts.length > 0 && (
        <div>
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Recent Payouts
          </p>
          <div className="space-y-1">
            {payouts.slice(0, 5).map((p) => (
              <div key={p.id} className="flex items-center justify-between text-[12px]">
                <span className="text-muted-foreground">{fmtDate(p.arrival_date)}</span>
                <span className="tabular-nums font-medium text-foreground">
                  {fmt(p.amount_cents, p.currency)}
                </span>
                <Badge variant={p.status === "paid" ? "ok" : p.status === "pending" ? "warn" : "secondary"}>
                  {p.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
