import { cn } from "@/components/ui/cn";

const TIERS = [
  { label: "Tier 1", bps: 1200, threshold_cents: 0, label_threshold: "$0" },
  { label: "Tier 2", bps: 800, threshold_cents: 100_000, label_threshold: "$1k" },
  { label: "Tier 3", bps: 500, threshold_cents: 300_000, label_threshold: "$3k" },
  { label: "Tier 4", bps: 300, threshold_cents: 1_000_000, label_threshold: "$10k" },
];

function bpsToPct(bps: number) {
  return (bps / 100).toFixed(2) + "%";
}

function tierFromBps(bps: number) {
  if (bps <= 300) return 3;
  if (bps <= 500) return 2;
  if (bps <= 800) return 1;
  return 0;
}

export default function CommissionTierCard({
  effectiveCutBps,
  overrideBps,
  netMrrCents,
}: {
  effectiveCutBps: number;
  overrideBps: number | null;
  netMrrCents: number;
}) {
  const currentTierIdx = tierFromBps(effectiveCutBps);
  const nextTier = TIERS[currentTierIdx + 1] ?? null;

  // Progress toward next tier (0–100)
  const progress = nextTier
    ? Math.min(
        100,
        Math.round(
          ((netMrrCents - TIERS[currentTierIdx].threshold_cents) /
            (nextTier.threshold_cents - TIERS[currentTierIdx].threshold_cents)) *
            100
        )
      )
    : 100;

  return (
    <div className="space-y-4">
      {overrideBps != null ? (
        <div className="bg-muted/40 rounded-lg p-3 flex items-start gap-2">
          <span className="mt-0.5 text-[16px]">🔧</span>
          <div>
            <p className="text-[13px] font-medium text-foreground">
              Custom rate: {bpsToPct(overrideBps)}
            </p>
            <p className="text-[12px] text-muted-foreground">
              Set by admin — overrides the standard 4-tier system.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-end justify-between">
            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Current tier</p>
              <p className="text-[22px] font-semibold text-foreground tabular-nums">
                {bpsToPct(effectiveCutBps)}
              </p>
              <p className="text-[12px] text-muted-foreground">{TIERS[currentTierIdx]?.label}</p>
            </div>
            {nextTier && (
              <p className="text-[12px] text-muted-foreground text-right">
                Next: {bpsToPct(nextTier.bps)} at {nextTier.label_threshold}/mo net
              </p>
            )}
          </div>

          {/* Progress bar through tiers */}
          <div>
            <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
              <span>Tier progression (by net MRR)</span>
              {nextTier && <span>{progress}%</span>}
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${nextTier ? progress : 100}%` }}
              />
            </div>
            <div className="flex justify-between mt-1">
              {TIERS.map((t, i) => (
                <span
                  key={t.bps}
                  className={cn(
                    "text-[10px]",
                    i === currentTierIdx
                      ? "text-primary font-medium"
                      : "text-muted-foreground"
                  )}
                >
                  {t.label_threshold}
                </span>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Transparent fee breakdown */}
      <div className="space-y-1 text-[13px]">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
          How your payout is calculated
        </p>
        <div className="flex justify-between py-1 border-b border-border-soft">
          <span className="text-muted-foreground">Gross subscription revenue</span>
          <span>100%</span>
        </div>
        <div className="flex justify-between py-1 border-b border-border-soft">
          <span className="text-muted-foreground">− Stripe processing fees (~2.9% + $0.30)</span>
          <span className="text-bad">~3%</span>
        </div>
        <div className="flex justify-between py-1 border-b border-border-soft">
          <span className="text-muted-foreground">
            − Platform fee ({bpsToPct(effectiveCutBps)} of net)
          </span>
          <span className="text-bad">{bpsToPct(effectiveCutBps)}</span>
        </div>
        <div className="flex justify-between py-1 font-medium">
          <span>= Vendor payout (approx.)</span>
          <span className="text-ok">
            ~{(100 - 3 - effectiveCutBps / 100).toFixed(1)}%
          </span>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Affiliate sales: platform takes 5% flat + affiliate commission (vendor-funded). Reseller sales: you receive your floor price only.{" "}
        <a href="/legal/fees" className="underline hover:text-foreground">
          Full fee schedule →
        </a>
      </p>
    </div>
  );
}
