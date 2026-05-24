"use client";

import { useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import type { ChannelMix } from "@/lib/services/vendor";

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

const CHANNELS = [
  { key: "direct", label: "Direct", color: "hsl(var(--primary))" },
  { key: "affiliate", label: "Affiliate", color: "#22c55e" },
  { key: "reseller", label: "Reseller", color: "#f59e0b" },
] as const;

type Channel = (typeof CHANNELS)[number]["key"];

function SvgDonut({ mix }: { mix: ChannelMix }) {
  const r = 40;
  const cx = 52;
  const cy = 52;
  const circumference = 2 * Math.PI * r;
  const total = mix.total_cents || 1;

  const segments: { channel: Channel; pct: number }[] = [
    { channel: "direct", pct: mix.direct_cents / total },
    { channel: "affiliate", pct: mix.affiliate_cents / total },
    { channel: "reseller", pct: mix.reseller_cents / total },
  ];

  let offset = 0;
  const arcs = segments.map((s) => {
    const dash = s.pct * circumference;
    const gap = circumference - dash;
    const arc = { channel: s.channel, dash, gap, offset };
    offset += dash;
    return arc;
  });

  return (
    <svg width={104} height={104} viewBox="0 0 104 104" className="shrink-0">
      {/* Background ring */}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={14} />
      {arcs.map((arc) => {
        const color = CHANNELS.find((c) => c.key === arc.channel)?.color ?? "#ccc";
        return (
          <circle
            key={arc.channel}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={14}
            strokeDasharray={`${arc.dash} ${arc.gap}`}
            strokeDashoffset={-arc.offset}
            style={{ transform: "rotate(-90deg)", transformOrigin: "52px 52px" }}
          />
        );
      })}
      <text x={cx} y={cy + 5} textAnchor="middle" className="text-[11px] font-semibold fill-foreground">
        {formatCents(mix.total_cents)}
      </text>
    </svg>
  );
}

export default function ChannelMixDonut({ mix }: { mix: ChannelMix }) {
  const [drawerChannel, setDrawerChannel] = useState<Channel | null>(null);
  const total = mix.total_cents || 1;

  const rows = [
    {
      channel: "direct" as Channel,
      cents: mix.direct_cents,
      count: mix.direct_count,
    },
    {
      channel: "affiliate" as Channel,
      cents: mix.affiliate_cents,
      count: mix.affiliate_count,
    },
    {
      channel: "reseller" as Channel,
      cents: mix.reseller_cents,
      count: mix.reseller_count,
    },
  ];

  return (
    <>
      <div className="flex items-center gap-6 flex-wrap">
        <SvgDonut mix={mix} />

        <div className="flex-1 min-w-[160px] space-y-2">
          {rows.map(({ channel, cents, count }) => {
            const pct = ((cents / total) * 100).toFixed(1);
            const cfg = CHANNELS.find((c) => c.key === channel)!;
            return (
              <button
                key={channel}
                type="button"
                onClick={() => setDrawerChannel(channel)}
                className="flex items-center gap-2 w-full text-left hover:bg-muted/40 rounded px-1 py-0.5 transition-colors group"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: cfg.color }}
                />
                <span className="text-[13px] text-foreground flex-1">{cfg.label}</span>
                <span className="text-[13px] tabular-nums text-muted-foreground">
                  {formatCents(cents)}
                </span>
                <span className="text-[11px] text-muted-foreground w-12 text-right">
                  {pct}%
                </span>
                <span className="text-[11px] text-muted-foreground w-14 text-right">
                  {count} sub{count !== 1 ? "s" : ""}
                </span>
                <span className="text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 ml-1">
                  →
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <Drawer
        open={drawerChannel !== null}
        onClose={() => setDrawerChannel(null)}
        title={`${drawerChannel ? CHANNELS.find((c) => c.key === drawerChannel)?.label : ""} channel`}
      >
        {drawerChannel && (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              Active subscriptions in the{" "}
              <strong className="text-foreground">
                {CHANNELS.find((c) => c.key === drawerChannel)?.label}
              </strong>{" "}
              channel.
            </p>
            {drawerChannel === "direct" && (
              <ChannelDetail
                label="Direct"
                cents={mix.direct_cents}
                count={mix.direct_count}
                description="Subscriptions with no affiliate or reseller attribution."
              />
            )}
            {drawerChannel === "affiliate" && (
              <ChannelDetail
                label="Affiliate"
                cents={mix.affiliate_cents}
                count={mix.affiliate_count}
                description="Subscriptions acquired through affiliate referral links. You pay affiliate commission from your cut."
              />
            )}
            {drawerChannel === "reseller" && (
              <ChannelDetail
                label="Reseller"
                cents={mix.reseller_cents}
                count={mix.reseller_count}
                description="Subscriptions sold via reseller storefronts. Revenue shown is your floor price — resellers keep the markup."
              />
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}

function ChannelDetail({
  label,
  cents,
  count,
  description,
}: {
  label: string;
  cents: number;
  count: number;
  description: string;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">{description}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-muted/40 rounded-lg p-3">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">MRR</p>
          <p className="text-lg font-semibold tabular-nums">{formatCents(cents)}</p>
        </div>
        <div className="bg-muted/40 rounded-lg p-3">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">Active subs</p>
          <p className="text-lg font-semibold tabular-nums">{count}</p>
        </div>
      </div>
    </div>
  );
}
