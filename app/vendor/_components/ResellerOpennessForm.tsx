"use client";

import { useActionState, startTransition } from "react";
import { setResellerOpennessAction } from "../actions";

type Openness = "closed" | "open_to_resellers" | "open_to_wl";

const OPTIONS: { value: Openness; label: string; desc: string }[] = [
  {
    value: "closed",
    label: "Closed",
    desc: "No resellers can list this app.",
  },
  {
    value: "open_to_resellers",
    label: "Open to resellers",
    desc: "Resellers can create Tier 1 storefronts at their own markup. You receive your set floor price.",
  },
  {
    value: "open_to_wl",
    label: "Open to white-label",
    desc: "Resellers can also upgrade to Tier 2 ($29/mo per offer) for subdomain storefronts. You earn a 33% kickback on the platform's 2.5% commission.",
  },
];

export default function ResellerOpennessForm({ current }: { current: Openness }) {
  const [state, action, pending] = useActionState(setResellerOpennessAction, null);

  return (
    <form action={action} className="space-y-2">
      {OPTIONS.map((opt) => (
        <label
          key={opt.value}
          className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
            current === opt.value
              ? "border-gray-900 bg-gray-50"
              : "border-gray-200 hover:border-gray-300"
          }`}
        >
          <input
            type="radio"
            name="openness"
            value={opt.value}
            defaultChecked={current === opt.value}
            className="mt-0.5 accent-gray-900"
            onChange={(e) => {
              if (e.target.checked) {
                startTransition(() => {
                  action(new FormData(e.target.form!));
                });
              }
            }}
          />
          <span>
            <span className="block text-sm font-medium">{opt.label}</span>
            <span className="block text-xs text-gray-700 mt-0.5">{opt.desc}</span>
          </span>
        </label>
      ))}
      {"error" in (state ?? {}) && (
        <p className="text-xs text-red-500">
          {typeof (state as {error: unknown}).error === "string"
            ? (state as {error: string}).error
            : "Invalid selection"}
        </p>
      )}
      {pending && <p className="text-xs text-gray-700">Saving…</p>}
    </form>
  );
}
