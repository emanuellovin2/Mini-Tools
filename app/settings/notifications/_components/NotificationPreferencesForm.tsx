"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import type { NotificationPreference } from "@/lib/services/notifications";

interface TypeDef {
  type: string;
  label: string;
  defaultEmailEnabled: boolean;
}

interface Props {
  types: TypeDef[];
  savedPrefs: NotificationPreference[];
}

type PrefMap = Record<string, NotificationPreference>;

export default function NotificationPreferencesForm({ types, savedPrefs }: Props) {
  const [, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const init: PrefMap = {};
  for (const t of types) {
    const existing = savedPrefs.find((p) => p.notif_type === t.type);
    init[t.type] = existing ?? {
      notif_type: t.type,
      in_app_enabled: true,
      email_enabled: t.defaultEmailEnabled,
      frequency: "immediate",
    };
  }
  const [prefs, setPrefs] = useState<PrefMap>(init);

  function toggle(type: string, field: "in_app_enabled" | "email_enabled") {
    setPrefs((p) => ({
      ...p,
      [type]: { ...p[type], [field]: !p[type][field] },
    }));
  }

  function setFrequency(type: string, freq: "immediate" | "daily" | "weekly") {
    setPrefs((p) => ({ ...p, [type]: { ...p[type], frequency: freq } }));
  }

  function handleSave() {
    startTransition(async () => {
      await Promise.all(
        Object.values(prefs).map((pref) =>
          fetch("/api/notifications/preferences", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(pref),
          })
        )
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    });
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        {/* header row */}
        <div className="grid grid-cols-[1fr_80px_80px_110px] gap-2 px-4 py-2 border-b border-border bg-muted/30 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          <span>Event</span>
          <span className="text-center">In-app</span>
          <span className="text-center">Email</span>
          <span className="text-center">Frequency</span>
        </div>

        {types.map((t) => {
          const p = prefs[t.type];
          return (
            <div
              key={t.type}
              className="grid grid-cols-[1fr_80px_80px_110px] gap-2 items-center px-4 py-3 border-b border-border-soft last:border-0"
            >
              <span className="text-[12px] text-foreground">{t.label}</span>

              <div className="flex justify-center">
                <Toggle on={p.in_app_enabled} onClick={() => toggle(t.type, "in_app_enabled")} />
              </div>

              <div className="flex justify-center">
                <Toggle on={p.email_enabled} onClick={() => toggle(t.type, "email_enabled")} />
              </div>

              <select
                value={p.frequency}
                onChange={(e) => setFrequency(t.type, e.target.value as "immediate" | "daily" | "weekly")}
                disabled={!p.email_enabled}
                className="text-[11px] border border-border rounded-md px-2 py-1 bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-40"
              >
                <option value="immediate">Immediate</option>
                <option value="daily">Daily digest</option>
                <option value="weekly">Weekly digest</option>
              </select>
            </div>
          );
        })}
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} size="sm">Save preferences</Button>
        {saved && <Badge variant="ok">Saved</Badge>}
      </div>
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`relative w-8 h-4.5 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${on ? "bg-primary" : "bg-muted-2"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${on ? "translate-x-3.5" : "translate-x-0"}`}
      />
    </button>
  );
}
