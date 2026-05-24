import { VENDOR_WL_KICKBACK_BPS } from "@/lib/stripe/transfers";
import { Tooltip } from "@/components/ui/Tooltip";

export default function KickbackCard() {
  const kickbackPct = ((VENDOR_WL_KICKBACK_BPS / 10_000) * 100).toFixed(2);
  const platformTier2Pct = 2.5;
  const vendorKickbackOfSale = ((platformTier2Pct * VENDOR_WL_KICKBACK_BPS) / 10_000).toFixed(2);
  const platformKeeps = (platformTier2Pct - Number(vendorKickbackOfSale)).toFixed(2);

  return (
    <div className="bg-surface rounded-[10px] border border-border shadow-[var(--shadow-card)] p-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[13px] font-semibold text-foreground">WL Tier 2 fee breakdown</h2>
        <Tooltip content="How platform commissions flow on Tier 2 white-label sales.">
          <span className="w-4 h-4 rounded-full bg-muted text-muted-foreground text-[10px] flex items-center justify-center cursor-default">
            ?
          </span>
        </Tooltip>
      </div>

      <div className="space-y-2 text-[12px]">
        <div className="flex justify-between text-muted-foreground border-b border-border pb-2">
          <span>Platform takes from markup</span>
          <span className="font-semibold text-foreground">{platformTier2Pct}%</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>
            Of that, {kickbackPct}% goes back to vendor as kickback
            <span className="text-[11px] opacity-70 ml-1">(open_to_wl only)</span>
          </span>
          <span className="font-semibold text-foreground">{vendorKickbackOfSale}%</span>
        </div>
        <div className="flex justify-between text-muted-foreground border-t border-border pt-2">
          <span>Platform net</span>
          <span className="font-semibold text-foreground">{platformKeeps}%</span>
        </div>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
        You compete with the vendor's own pricing — set your price accordingly. Percentages
        apply to the <strong>markup</strong> (your price − vendor floor), not gross.
      </p>
    </div>
  );
}
