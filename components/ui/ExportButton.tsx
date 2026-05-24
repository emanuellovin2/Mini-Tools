"use client";

import { useState } from "react";
import { Button } from "./Button";
import type { ExportScope } from "@/lib/services/export";

interface Props {
  scope: ExportScope;
  label?: string;
  className?: string;
}

/**
 * Triggers a CSV export for the given scope.
 * For ≤10k rows: the API streams the file and the browser downloads it directly.
 * For >10k rows: the API enqueues an async job and shows a "check your email" message.
 */
export function ExportButton({ scope, label = "Export CSV", className }: Props) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/account/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      });

      if (res.headers.get("content-type")?.includes("text/csv")) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const disposition = res.headers.get("content-disposition") ?? "";
        const match = disposition.match(/filename="([^"]+)"/);
        a.href = url;
        a.download = match?.[1] ?? "export.csv";
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const data = await res.json();
        if (data.mode === "async") {
          setMessage("Large export queued — check your email.");
        } else if (data.error) {
          setMessage(`Error: ${data.error}`);
        }
      }
    } catch {
      setMessage("Export failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="inline-flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={loading}
        className={className}
      >
        {loading ? "Exporting…" : label}
      </Button>
      {message && (
        <span className="text-[11px] text-muted-foreground">{message}</span>
      )}
    </div>
  );
}
