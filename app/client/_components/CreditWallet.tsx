import Link from "next/link";

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

export function CreditWallet({ balanceCents }: { balanceCents: number }) {
  const low = balanceCents < 500_00; // under $500

  return (
    <div className="rounded-xl border border-border p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold">Credit wallet</h2>
        <Link
          href="/api/credits/topup"
          className="text-xs font-medium text-primary hover:underline"
        >
          Top up →
        </Link>
      </div>

      <p className="text-2xl font-bold text-foreground">{formatCents(balanceCents)}</p>
      <p className="text-xs text-muted-foreground mt-0.5">Available balance</p>

      {low && (
        <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          Balance is low. Top up to keep your agents running without interruption.
        </div>
      )}
    </div>
  );
}
