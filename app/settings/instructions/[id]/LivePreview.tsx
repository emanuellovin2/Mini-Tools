"use client";

import type { ScopeLevel } from "@/lib/instructions/resolve";

interface LivePreviewProps {
  systemPrompt: string;
  resolvedFrom: ScopeLevel[];
}

const SCOPE_LABEL: Record<ScopeLevel, string> = {
  global: "global",
  project: "project",
  client: "client",
  deployment: "deployment",
};

export function LivePreview({ systemPrompt, resolvedFrom }: LivePreviewProps) {
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Live resolved preview</h3>
        {resolvedFrom.length > 0 && (
          <p className="text-xs text-muted-foreground">
            from: {resolvedFrom.map((s) => SCOPE_LABEL[s]).join(" + ")}
          </p>
        )}
      </div>

      {systemPrompt ? (
        <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs font-mono text-foreground">
          {systemPrompt}
        </pre>
      ) : (
        <div className="rounded-md bg-muted/30 p-3 text-xs text-muted-foreground">
          No published instruction set active — the model will receive no system prompt from this scope.
        </div>
      )}
    </div>
  );
}
