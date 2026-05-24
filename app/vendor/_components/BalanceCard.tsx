import type { VendorBalance } from "@/lib/services/vendor";
import { Badge } from "@/components/ui/Badge";

function formatCents(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

export default function BalanceCard({
  balance,
  stripeAccountId,
  chargesEnabled,
  payoutsEnabled,
}: {
  balance: VendorBalance;
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}) {
  if (!stripeAccountId) {
    return (
      <div className="rounded-[10px] border border-border p-4 bg-surface shadow-[var(--shadow-card)]">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
          Stripe Connect
        </p>
        <p className="text-[13px] text-muted-foreground">
          Connect your Stripe account to see balance and payout info.
        </p>
      </div>
    );
  }

  const statusVariant = chargesEnabled && payoutsEnabled
    ? "ok"
    : chargesEnabled
    ? "warn"
    : "bad";

  const statusLabel = chargesEnabled && payoutsEnabled
    ? "Active"
    : chargesEnabled
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

      {balance.connected ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] text-muted-foreground mb-0.5">Available</p>
            <p className="text-[20px] font-semibold tabular-nums text-foreground">
              {formatCents(balance.available_cents, balance.currency)}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground mb-0.5">Pending</p>
            <p className="text-[20px] font-semibold tabular-nums text-foreground">
              {formatCents(balance.pending_cents, balance.currency)}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          Balance unavailable — check your Stripe account.
        </p>
      )}

      <p className="text-[11px] text-muted-foreground">
        Payouts run weekly on Fridays. Funds take 2–7 business days to arrive.
      </p>
    </div>
  );
}
