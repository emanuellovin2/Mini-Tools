import Link from "next/link";

const TIERS = [
  { label: "Standard", min_cents: 0, bps: 2000 },
  { label: "Silver", min_cents: 500_000, bps: 2500 },
  { label: "Gold", min_cents: 2_000_000, bps: 3000 },
];

function currentTier(activeMrrCents: number) {
  if (activeMrrCents >= 2_000_000) return TIERS[2];
  if (activeMrrCents >= 500_000) return TIERS[1];
  return TIERS[0];
}

function nextTier(activeMrrCents: number) {
  if (activeMrrCents >= 2_000_000) return null;
  if (activeMrrCents >= 500_000) return TIERS[2];
  return TIERS[1];
}

function formatCents(cents: number) {
  return "$" + Math.round(cents / 100).toLocaleString();
}

export default function HeroBanner({
  activeMrrCents,
  lifetimeMrrCents,
  rank,
}: {
  activeMrrCents: number;
  lifetimeMrrCents: number;
  rank: number | null;
}) {
  const tier = currentTier(activeMrrCents);
  const next = nextTier(activeMrrCents);
  const progress = next
    ? Math.min(
        100,
        Math.round(
          ((activeMrrCents - (TIERS[TIERS.indexOf(tier)].min_cents)) /
            (next.min_cents - TIERS[TIERS.indexOf(tier)].min_cents)) *
            100
        )
      )
    : 100;
  const toNextCents = next ? next.min_cents - activeMrrCents : 0;

  return (
    <div className="rounded-[12px] bg-gradient-to-br from-primary/90 to-primary p-5 text-primary-foreground">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] font-medium opacity-75 uppercase tracking-wide mb-1">
            Active MRR generated
          </p>
          <p className="text-[32px] font-bold tabular-nums leading-none">
            {formatCents(activeMrrCents)}
          </p>
          <p className="text-[12px] opacity-70 mt-1">
            Lifetime: {formatCents(lifetimeMrrCents)}
          </p>
        </div>

        <div className="text-right shrink-0">
          <span className="inline-block text-[11px] font-semibold bg-white/20 rounded-full px-3 py-1">
            {tier.label} — {(tier.bps / 100).toFixed(0)}% commission
          </span>
          {rank && (
            <p className="text-[12px] opacity-75 mt-2">
              <Link href="/affiliates/top" className="underline">
                #{rank} on leaderboard
              </Link>
            </p>
          )}
        </div>
      </div>

      {next && (
        <div className="mt-4">
          <div className="flex justify-between text-[11px] opacity-75 mb-1">
            <span>{tier.label}</span>
            <span>{formatCents(toNextCents)} to {next.label} ({(next.bps / 100).toFixed(0)}%)</span>
          </div>
          <div className="h-1.5 bg-white/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-white/80 rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {!next && (
        <p className="mt-3 text-[12px] opacity-75">
          🏆 Maximum tier reached — you earn {(tier.bps / 100).toFixed(0)}% on every sale.
        </p>
      )}
    </div>
  );
}
