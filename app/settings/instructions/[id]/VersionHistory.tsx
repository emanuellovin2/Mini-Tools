"use client";

import { useState, useTransition } from "react";
import { actionRollback } from "../actions";
import { diffVersions } from "@/lib/instructions/diff";
import type { InstructionVersion } from "@/lib/services/instructions";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

interface VersionHistoryProps {
  instructionSetId: string;
  versions: InstructionVersion[];
  activeVersionId: string | null;
}

export function VersionHistory({
  instructionSetId,
  versions,
  activeVersionId,
}: VersionHistoryProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  function handleRollback(versionId: string) {
    setRollbackError(null);
    startTransition(async () => {
      try {
        await actionRollback(instructionSetId, versionId);
      } catch (err) {
        setRollbackError(err instanceof Error ? err.message : "Rollback failed");
      }
    });
  }

  // Build a diff when a version row is expanded
  function getDiff(ver: InstructionVersion) {
    const idx = versions.findIndex((v) => v.id === ver.id);
    const prev = versions[idx + 1]; // versions are desc by version number
    if (!prev) return null;
    return diffVersions({ blocks: prev.blocks }, { blocks: ver.blocks });
  }

  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-sm">Version history</h3>
      {rollbackError && <p className="text-xs text-destructive">{rollbackError}</p>}

      <div className="divide-y rounded-lg border">
        {versions.map((ver) => {
          const isActive = ver.id === activeVersionId;
          const diffs = expanded === ver.id ? getDiff(ver) : null;

          return (
            <div key={ver.id} className="px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-sm font-semibold shrink-0">v{ver.version}</span>
                  {isActive && <Badge variant="default">active</Badge>}
                  <span className="text-xs text-muted-foreground truncate">
                    {new Date(ver.created_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === ver.id ? null : ver.id)}
                    className="text-xs text-primary underline-offset-2 hover:underline"
                  >
                    {expanded === ver.id ? "Hide diff" : "Diff"}
                  </button>
                  {!isActive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRollback(ver.id)}
                      disabled={isPending}
                    >
                      Rollback
                    </Button>
                  )}
                </div>
              </div>

              {/* Diff view */}
              {expanded === ver.id && (
                <div className="rounded-md bg-muted/30 p-3 space-y-2 text-xs font-mono">
                  {diffs === null ? (
                    <p className="text-muted-foreground">First version — no previous to diff against.</p>
                  ) : diffs.length === 0 ? (
                    <p className="text-muted-foreground">No changes from previous version.</p>
                  ) : (
                    diffs.map((d) => (
                      <div key={d.key} className="space-y-1">
                        <p className="font-semibold text-foreground">
                          {d.key}{" "}
                          <span
                            className={
                              d.kind === "added"
                                ? "text-green-600"
                                : d.kind === "removed"
                                ? "text-red-600"
                                : "text-yellow-600"
                            }
                          >
                            [{d.kind}]
                          </span>
                        </p>
                        {d.textBefore && (
                          <pre className="text-red-700 whitespace-pre-wrap break-words">
                            {d.textBefore
                              .split("\n")
                              .map((l) => `- ${l}`)
                              .join("\n")}
                          </pre>
                        )}
                        {d.textAfter && (
                          <pre className="text-green-700 whitespace-pre-wrap break-words">
                            {d.textAfter
                              .split("\n")
                              .map((l) => `+ ${l}`)
                              .join("\n")}
                          </pre>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
