"use client";

import { useState, useTransition } from "react";
import { setFeatureFlagAction } from "@/app/admin/actions";
import type { FeatureFlag } from "@/lib/services/admin";
import { Badge } from "@/components/ui/Badge";

export function FeatureFlagsPanel({ flags }: { flags: FeatureFlag[] }) {
  const [pending, startTransition] = useTransition();
  const [local, setLocal] = useState<Record<string, boolean>>(
    Object.fromEntries(flags.map((f) => [f.name, f.enabled]))
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  function toggle(name: string) {
    const next = !local[name];
    setLocal((prev) => ({ ...prev, [name]: next }));
    setErrors((prev) => ({ ...prev, [name]: "" }));
    startTransition(async () => {
      const res = await setFeatureFlagAction({ name, enabled: next });
      if ("error" in res) {
        setLocal((prev) => ({ ...prev, [name]: !next }));
        setErrors((prev) => ({ ...prev, [name]: res.error }));
      }
    });
  }

  const FLAG_LABELS: Record<string, string> = {
    wl_tier2_signup: "White-label Tier 2 signups",
    affiliate_signup: "Affiliate signups",
    reseller_signup: "Reseller subscriptions",
    new_app_submissions: "New app submissions",
    payouts: "Stripe payouts",
  };

  return (
    <div className="space-y-2">
      {flags.map((flag) => {
        const isOn = local[flag.name] ?? flag.enabled;
        return (
          <div
            key={flag.name}
            className="flex items-center justify-between gap-4 p-3 rounded-lg border border-border bg-surface"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {FLAG_LABELS[flag.name] ?? flag.name}
              </p>
              {flag.description && (
                <p className="text-xs text-muted-foreground mt-0.5">{flag.description}</p>
              )}
              {errors[flag.name] && (
                <p className="text-xs text-bad mt-0.5">{errors[flag.name]}</p>
              )}
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => toggle(flag.name)}
              aria-label={`Toggle ${flag.name}`}
              className={[
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent",
                "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                "disabled:opacity-50",
                isOn ? "bg-primary" : "bg-muted-foreground/30",
              ].join(" ")}
            >
              <span
                className={[
                  "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm",
                  "transition-transform",
                  isOn ? "translate-x-4" : "translate-x-0",
                ].join(" ")}
              />
            </button>
          </div>
        );
      })}
      {flags.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">No feature flags configured.</p>
      )}
    </div>
  );
}
