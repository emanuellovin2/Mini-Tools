import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import type { AffiliatePayoutRow } from "@/lib/services/affiliate";

function formatCents(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const STATUS_VARIANT: Record<string, "ok" | "warn" | "bad" | "outline"> = {
  paid: "ok",
  in_transit: "warn",
  pending: "warn",
  canceled: "bad",
  failed: "bad",
};

export default function PayoutHistoryCard({ payouts }: { payouts: AffiliatePayoutRow[] }) {
  return (
    <DenseTable
      cols={["Arrival date", "Amount", "Status"]}
      empty={
        <EmptyState
          title="No payouts yet"
          body="Payouts run weekly on Fridays once your Stripe account is connected."
          cta={
            <a
              href="/api/affiliate/onboard"
              className="text-[12px] text-primary underline"
            >
              Connect Stripe →
            </a>
          }
        />
      }
    >
      {payouts.map((p) => (
        <DenseRow key={p.id} cols={3}>
          <DenseCell>{formatDate(p.arrival_date)}</DenseCell>
          <DenseCell align="right" className="font-medium tabular-nums">
            {formatCents(p.amount_cents, p.currency)}
          </DenseCell>
          <DenseCell>
            <Badge variant={STATUS_VARIANT[p.status] ?? "outline"}>{p.status}</Badge>
          </DenseCell>
        </DenseRow>
      ))}
    </DenseTable>
  );
}
