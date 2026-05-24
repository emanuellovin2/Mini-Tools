import type { ResellerAlert } from "@/lib/services/reseller";

const KIND_COLOR: Record<ResellerAlert["kind"], string> = {
  floor_change: "border-warn/30 bg-warn-soft text-warn",
  app_paused: "border-bad/30 bg-bad-soft text-bad",
  openness_downgrade: "border-warn/30 bg-warn-soft text-warn",
};

const KIND_ICON: Record<ResellerAlert["kind"], string> = {
  floor_change: "↑",
  app_paused: "⚠",
  openness_downgrade: "↓",
};

export default function AlertsBanner({ alerts }: { alerts: ResellerAlert[] }) {
  if (alerts.length === 0) return null;

  return (
    <div className="space-y-2">
      {alerts.map((a, i) => (
        <div
          key={`${a.offer_id}-${i}`}
          className={`flex items-start gap-3 rounded-[10px] border p-3 text-[13px] ${KIND_COLOR[a.kind]}`}
        >
          <span className="text-[14px] font-bold shrink-0 mt-px">{KIND_ICON[a.kind]}</span>
          <div className="min-w-0">
            <span className="font-semibold">{a.app_name} / /{a.offer_slug}</span>
            <span className="mx-1.5 opacity-60">·</span>
            <span>{a.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
