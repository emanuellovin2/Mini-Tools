import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { EmptyState } from "@/components/ui/EmptyState";
import type { EarningsByAppRow } from "@/lib/services/affiliate";

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

export default function EarningsByAppCard({ rows }: { rows: EarningsByAppRow[] }) {
  return (
    <DenseTable
      cols={["App", "Commission", "Active subs", "Est. earnings/mo", "Avg/sub"]}
      empty={
        <EmptyState
          title="No earnings yet"
          body="Earnings appear once your referrals subscribe to an app."
          cta={<span className="text-[12px] text-muted-foreground">Promote apps to earn commissions.</span>}
        />
      }
    >
      {rows.map((row) => (
        <DenseRow key={row.app_id} cols={5}>
          <DenseCell>
            <span className="font-medium">{row.app_name}</span>
          </DenseCell>
          <DenseCell>
            <span className="text-[12px] font-medium text-primary">
              {(row.commission_bps / 100).toFixed(0)}%
            </span>
          </DenseCell>
          <DenseCell align="right">{row.sale_count}</DenseCell>
          <DenseCell align="right" className="font-medium text-ok">
            {formatCents(row.earnings_cents)}
          </DenseCell>
          <DenseCell align="right" className="text-muted-foreground">
            {formatCents(row.avg_per_sale_cents)}
          </DenseCell>
        </DenseRow>
      ))}
    </DenseTable>
  );
}
