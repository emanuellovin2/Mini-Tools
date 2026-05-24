"use client";

import { useState } from "react";
import Image from "next/image";
import { Drawer } from "@/components/ui/Drawer";
import { Badge } from "@/components/ui/Badge";
import type { AffiliateFunnel } from "@/lib/services/affiliate";

type Link = {
  id: string;
  code: string;
  app_id: string | null;
  created_at: string;
};

function FunnelMini({ funnel }: { funnel: AffiliateFunnel | null }) {
  if (!funnel) return null;
  const total = funnel.total_attributed;
  if (total === 0)
    return <p className="text-[12px] text-muted-foreground">No conversions yet for this link.</p>;

  const pct = (n: number) => (total > 0 ? ((n / total) * 100).toFixed(1) + "%" : "—");

  return (
    <div className="space-y-2">
      {[
        { label: "Total paid", value: total },
        { label: "Active now", value: funnel.currently_active },
        { label: "Active 30d+", value: funnel.active_30d },
        { label: "Active 90d+", value: funnel.active_90d },
      ].map((s) => (
        <div key={s.label} className="flex items-center gap-2">
          <span className="w-24 text-[12px] text-muted-foreground shrink-0">{s.label}</span>
          <div className="flex-1 h-4 bg-muted/40 rounded overflow-hidden">
            <div
              className="h-full bg-primary/70 rounded"
              style={{ width: total > 0 ? `${(s.value / total) * 100}%` : "0%" }}
            />
          </div>
          <span className="w-8 text-[11px] text-right tabular-nums">{s.value}</span>
          <span className="w-10 text-[11px] text-muted-foreground text-right">{pct(s.value)}</span>
        </div>
      ))}
    </div>
  );
}

function ShareKit({ url, appName }: { url: string; appName: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(url)}`;

  const templates = [
    {
      id: "tweet",
      label: "Twitter / X",
      text: `🚀 I've been using ${appName} and it's changed how I work. Try it here:\n${url}`,
    },
    {
      id: "email",
      label: "Email",
      text: `Hi,\n\nI wanted to share ${appName} with you — it's a tool I've been finding really useful.\n\nYou can try it here: ${url}\n\nLet me know what you think!`,
    },
    {
      id: "linkedin",
      label: "LinkedIn",
      text: `Just discovered ${appName} and it's been a game-changer for my workflow.\n\nIf you're looking for a smarter way to work, check it out:\n${url}`,
    },
  ];

  const embed = `<a href="${url}" target="_blank" rel="noopener">Try ${appName}</a>`;

  async function copy(text: string, id: string) {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  async function downloadQr() {
    const res = await fetch(
      `https://api.qrserver.com/v1/create-qr-code/?size=1024x1024&data=${encodeURIComponent(url)}`
    );
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `referral-qr-${url.slice(-8)}.png`;
    a.click();
  }

  return (
    <div className="space-y-5">
      {/* QR Code */}
      <div className="flex flex-col items-center gap-3">
        <Image
          src={qrSrc}
          alt="QR code"
          width={180}
          height={180}
          className="rounded-lg border border-border"
          unoptimized
        />
        <button
          type="button"
          onClick={downloadQr}
          className="text-[12px] px-3 py-1.5 rounded-lg border border-border hover:bg-muted/40 transition-colors"
        >
          Download 1024×1024 PNG
        </button>
      </div>

      {/* Raw URL */}
      <div>
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
          Your link
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-[12px] font-mono bg-muted rounded px-2 py-1.5 truncate">
            {url}
          </code>
          <button
            type="button"
            onClick={() => copy(url, "url")}
            className="text-[12px] px-2 py-1 rounded border border-border hover:bg-muted/40 transition-colors shrink-0"
          >
            {copied === "url" ? "✓" : "Copy"}
          </button>
        </div>
      </div>

      {/* Share templates */}
      <div className="space-y-2">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          Share templates
        </p>
        {templates.map((t) => (
          <div key={t.id} className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-foreground">{t.label}</span>
              <button
                type="button"
                onClick={() => copy(t.text, t.id)}
                className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-muted/40 transition-colors"
              >
                {copied === t.id ? "✓ Copied" : "Copy"}
              </button>
            </div>
            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
              {t.text}
            </pre>
          </div>
        ))}
      </div>

      {/* Embed snippet */}
      <div>
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
          Embed snippet
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-[11px] font-mono bg-muted rounded px-2 py-1.5 truncate">
            {embed}
          </code>
          <button
            type="button"
            onClick={() => copy(embed, "embed")}
            className="text-[12px] px-2 py-1 rounded border border-border hover:bg-muted/40 transition-colors shrink-0"
          >
            {copied === "embed" ? "✓" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LinkShareDrawer({
  link,
  appUrl,
  appName,
  funnel,
  onClose,
}: {
  link: Link;
  appUrl: string;
  appName: string;
  funnel: AffiliateFunnel | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"funnel" | "share">("share");
  const url = `${appUrl}/marketplace?aff=${link.code}`;

  return (
    <Drawer
      open
      title={`Link · ${link.code}`}
      onClose={onClose}
    >
      <div className="space-y-4">
        {/* Meta */}
        <div className="flex items-center gap-2 flex-wrap">
          {link.app_id && (
            <Badge variant="outline">
              App: {appName}
            </Badge>
          )}
          {!link.app_id && <Badge variant="outline">Generic link</Badge>}
          <span className="text-[11px] text-muted-foreground">
            Created {new Date(link.created_at).toLocaleDateString()}
          </span>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border">
          {(["share", "funnel"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`text-[13px] px-3 py-2 -mb-px transition-colors ${
                tab === t
                  ? "border-b-2 border-primary font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "share" ? "Share kit" : "Funnel"}
            </button>
          ))}
        </div>

        {tab === "share" && <ShareKit url={url} appName={appName} />}
        {tab === "funnel" && (
          <div className="pt-1">
            <FunnelMini funnel={funnel} />
          </div>
        )}
      </div>
    </Drawer>
  );
}
