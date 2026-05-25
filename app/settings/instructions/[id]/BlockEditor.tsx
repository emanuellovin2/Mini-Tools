"use client";

import { useState, useTransition } from "react";
import { actionPublishVersion } from "../actions";
import type { Block } from "@/lib/instructions/resolve";
import { Button } from "@/components/ui/Button";

interface BlockEditorProps {
  instructionSetId: string;
  initialBlocks: Block[];
  initialVariables: Record<string, string>;
}

const emptyBlock = (): Block => ({ key: "", mode: "replace", text: "" });

export function BlockEditor({
  instructionSetId,
  initialBlocks,
  initialVariables,
}: BlockEditorProps) {
  const [blocks, setBlocks] = useState<Block[]>(
    initialBlocks.length > 0 ? initialBlocks : [emptyBlock()]
  );
  const [variables, setVariables] = useState<Record<string, string>>(initialVariables);
  const [newVarKey, setNewVarKey] = useState("");
  const [newVarVal, setNewVarVal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  function updateBlock(i: number, partial: Partial<Block>) {
    setBlocks((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...partial } : b)));
  }

  function removeBlock(i: number) {
    setBlocks((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addBlock() {
    setBlocks((prev) => [...prev, emptyBlock()]);
  }

  function addVariable() {
    if (!newVarKey.trim()) return;
    setVariables((prev) => ({ ...prev, [newVarKey.trim()]: newVarVal }));
    setNewVarKey("");
    setNewVarVal("");
  }

  function removeVariable(key: string) {
    setVariables((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function handlePublish() {
    setError(null);
    setSuccess(false);
    const invalid = blocks.find((b) => !b.key.trim() || !b.text.trim());
    if (invalid) {
      setError("All blocks must have a key and text.");
      return;
    }

    startTransition(async () => {
      try {
        await actionPublishVersion(instructionSetId, blocks, variables);
        setSuccess(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Publish failed");
      }
    });
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <h3 className="font-semibold text-sm">Blocks</h3>
      <p className="text-xs text-muted-foreground">
        Each block has a <code className="font-mono">key</code> and a{" "}
        <code className="font-mono">mode</code>. Use{" "}
        <code className="font-mono">replace</code> to override a parent scope&#39;s
        block, or <code className="font-mono">append</code> to extend it.
        Use <code className="font-mono">{"{{var}}"}</code> for variable interpolation.
      </p>

      <div className="space-y-3">
        {blocks.map((b, i) => (
          <div key={i} className="rounded-md border p-3 space-y-2 bg-muted/20">
            <div className="flex gap-2">
              <input
                value={b.key}
                onChange={(e) => updateBlock(i, { key: e.target.value })}
                placeholder="key (e.g. persona)"
                className="flex-1 rounded-md border bg-background px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <select
                value={b.mode}
                onChange={(e) => updateBlock(i, { mode: e.target.value as Block["mode"] })}
                className="rounded-md border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="replace">replace</option>
                <option value="append">append</option>
              </select>
              <button
                type="button"
                onClick={() => removeBlock(i)}
                className="text-muted-foreground hover:text-destructive text-sm px-1"
                aria-label="Remove block"
              >
                ✕
              </button>
            </div>
            <textarea
              value={b.text}
              onChange={(e) => updateBlock(i, { text: e.target.value })}
              rows={4}
              placeholder="System prompt text for this block…"
              className="w-full rounded-md border bg-background px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary resize-y"
            />
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addBlock}
        className="text-sm text-primary underline-offset-2 hover:underline"
      >
        + Add block
      </button>

      {/* Variables */}
      <div className="space-y-2 pt-2 border-t">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Variables</h4>
        {Object.entries(variables).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 text-sm">
            <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{`{{${k}}}`}</code>
            <span className="flex-1 truncate text-muted-foreground">{v}</span>
            <button
              type="button"
              onClick={() => removeVariable(k)}
              className="text-muted-foreground hover:text-destructive text-xs"
            >
              ✕
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <input
            value={newVarKey}
            onChange={(e) => setNewVarKey(e.target.value)}
            placeholder="variable name"
            className="w-32 rounded-md border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            value={newVarVal}
            onChange={(e) => setNewVarVal(e.target.value)}
            placeholder="default value"
            className="flex-1 rounded-md border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={addVariable}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            + Add
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {success && <p className="text-xs text-green-600">Published successfully.</p>}

      <Button size="sm" onClick={handlePublish} disabled={isPending}>
        {isPending ? "Publishing…" : "Publish version"}
      </Button>
    </div>
  );
}
