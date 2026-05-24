"use client";

import { useActionState, startTransition } from "react";
import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { setResellerOpennessAction } from "../actions";
import type { ResellerKickbackResult } from "@/lib/services/vendor";

type Openness = "closed" | "open_to_resellers" | "open_to_wl";

const OPTIONS: { value: Openness; label: string; desc: string }[] = [
  {
    value: "closed",
    label: "Closed",
    desc: "No resellers can list your apps.",
  },
  {
    value: "open_to_resellers",
    label: "Open to resellers",
    desc: "Resellers can create Tier 1 storefronts. You receive your floor price per sale.",
  },
  {
    value: "open_to_wl",
    label: "Open to white-label",
    desc: "Resellers can upgrade to Tier 2 ($29/mo per offer) for subdomain storefronts. You earn a 33% kickback on the platform's 2.5% reseller commission.",
  },
];

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

export default function ResellerKickbackPanel({
  current,
  kickback,
}: {
  current: Openness;
  kickback: ResellerKickbackResult;
}) {
  const [state, action, pending] = useActionState(setResellerOpennessAction, null);

  return (
    <div className="space-y-4">
      {/* 3-state toggle */}
      <form className="space-y-2">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              current === opt.value
                ? "border-primary bg-primary/5"
                : "border-border hover:border-border-dark"
            }`}
          >
            <input
              type="radio"
              name="openness"
              value={opt.value}
              defaultChecked={current === opt.value}
              className="mt-0.5 accent-primary"
              onChange={(e) => {
                if (e.target.checked) {
                  startTransition(() => action(new FormData(e.target.form!)));
                }
              }}
            />
            <span>
              <span className="block text-[13px] font-medium text-foreground">{opt.label}</span>
              <span className="block text-[12px] text-muted-foreground mt-0.5">{opt.desc}</span>
            </span>
          </label>
        ))}
        {"error" in (state ?? {}) && (
          <p className="text-[12px] text-bad">
            {typeof (state as { error: unknown }).error === "string"
              ? (state as { error: string }).error
              : "Invalid selection"}
          </p>
        )}
        {pending && <p className="text-[12px] text-muted-foreground">Saving…</p>}
      </form>

      {/* Kickback earnings (only when open_to_wl) */}
      {current === "open_to_wl" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              WL kickback (active subs)
            </p>
            <p className="text-[15px] font-semibold text-ok tabular-nums">
              {formatCents(kickback.total_kickback_cents)}/mo
            </p>
          </div>

          <DenseTable
            cols={["Reseller", "Subs", "Kickback/mo"]}
            empty={
              <EmptyState
                title="No Tier 2 resellers yet"
                body="Resellers can upgrade their storefront to Tier 2 for $29/mo."
                cta={<span className="text-[12px] text-muted-foreground">Share your apps to attract resellers.</span>}
              />
            }
          >
            {kickback.by_reseller.map((r) => (
              <DenseRow key={r.reseller_id} cols={3}>
                <DenseCell>
                  {r.slug ? (
                    <span className="font-medium">{r.slug}</span>
                  ) : (
                    <span className="text-muted-foreground font-mono text-[11px]">
                      {r.reseller_id.slice(0, 8)}…
                    </span>
                  )}
                </DenseCell>
                <DenseCell>{r.sale_count}</DenseCell>
                <DenseCell align="right" className="text-ok font-medium">
                  {formatCents(r.kickback_cents)}
                </DenseCell>
              </DenseRow>
            ))}
          </DenseTable>

          <p className="text-[11px] text-muted-foreground">
            Kickback = 33% × (platform&apos;s 2.5% of markup). Estimated from active subs at floor snapshot.
          </p>
        </div>
      )}
    </div>
  );
}
