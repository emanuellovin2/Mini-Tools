import type { PendingEarnings, ClawbackRow } from "@/lib/services/affiliate";
import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { EmptyState } from "@/components/ui/EmptyState";

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

export function PendingEarningsCard({ pending }: { pending: PendingEarnings }) {
  const total = pending.confirmed_cents + pending.in_clawback_cents;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-ok-soft rounded-lg p-3">
          <p className="text-[11px] text-ok uppercase tracking-wide font-medium mb-1">
            Confirmed
          </p>
          <p className="text-[20px] font-semibold tabular-nums text-ok">
            {formatCents(pending.confirmed_cents)}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Past clawback window (~30d)
          </p>
        </div>
        <div className="bg-warn-soft rounded-lg p-3">
          <p className="text-[11px] text-warn uppercase tracking-wide font-medium mb-1">
            In clawback window
          </p>
          <p className="text-[20px] font-semibold tabular-nums text-warn">
            {formatCents(pending.in_clawback_cents)}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Subs ≤30d old — may be refunded
          </p>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Total estimated earnings: <strong className="text-foreground">{formatCents(total)}/mo</strong>.
        Confirmed commissions are paid out weekly on Fridays to your Stripe account.
        If a subscriber refunds within ~30 days, the commission is clawed back.
      </p>
    </div>
  );
}

export function ClawbacksCard({ clawbacks }: { clawbacks: ClawbackRow[] }) {
  return (
    <DenseTable
      cols={["Date", "Amount clawed back", "Description"]}
      empty={
        <EmptyState
          title="No clawbacks"
          body="No commission was clawed back in the last 30 days."
          cta={<span className="text-[12px] text-muted-foreground">Keep promoting quality traffic.</span>}
        />
      }
    >
      {clawbacks.map((c) => (
        <DenseRow key={c.id} cols={3}>
          <DenseCell className="text-muted-foreground">{formatDate(c.date)}</DenseCell>
          <DenseCell align="right" className="text-bad font-medium tabular-nums">
            −{formatCents(c.amount_cents)}
          </DenseCell>
          <DenseCell className="text-muted-foreground truncate">{c.description}</DenseCell>
        </DenseRow>
      ))}
    </DenseTable>
  );
}
