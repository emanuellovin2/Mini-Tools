"use client";

import { useState, useEffect } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import type { VisualNode, NodeType } from "@/lib/workflows/graph-schema";
import type { GraphValidationError } from "@/lib/workflows/graph-schema";

interface ConfigDrawerProps {
  node: VisualNode | null;
  errors: GraphValidationError[];
  onClose: () => void;
  onSave: (nodeId: string, config: Record<string, unknown>, label: string) => void;
}

export function ConfigDrawer({ node, errors, onClose, onSave }: ConfigDrawerProps) {
  const [configText, setConfigText] = useState("");
  const [label, setLabel] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (node) {
      // Strip _ui_* keys from display
      const display: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.config)) {
        if (!k.startsWith("_ui")) display[k] = v;
      }
      setConfigText(JSON.stringify(display, null, 2));
      setLabel(node.label ?? node.id);
      setParseError(null);
    }
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!node) return null;

  const nodeErrors = errors.filter((e) => e.node_id === node.id);

  function handleSave() {
    try {
      const parsed = JSON.parse(configText);
      onSave(node!.id, parsed, label);
      setParseError(null);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON");
    }
  }

  return (
    <Drawer open={!!node} onClose={onClose} title={`Configure: ${node.type}`}>
      <div className="flex flex-col gap-4">
        {/* Label */}
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Step label</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        {/* Validation errors for this node */}
        {nodeErrors.length > 0 && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
            <p className="text-xs font-semibold text-red-700 mb-1">Validation errors</p>
            {nodeErrors.map((err, i) => (
              <p key={i} className="text-xs text-red-600">
                {err.field ? <strong>{err.field}: </strong> : null}{err.message}
              </p>
            ))}
          </div>
        )}

        {/* Type-specific hint */}
        <ConfigHint type={node.type} />

        {/* JSON config editor */}
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Config (JSON)</label>
          <textarea
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono h-64 resize-y focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            value={configText}
            onChange={(e) => {
              setConfigText(e.target.value);
              setParseError(null);
            }}
            spellCheck={false}
          />
          {parseError && (
            <p className="text-xs text-red-600 mt-1">{parseError}</p>
          )}
        </div>

        <div className="flex gap-2 justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave}>Apply</Button>
        </div>
      </div>
    </Drawer>
  );
}

function ConfigHint({ type }: { type: NodeType }) {
  const hints: Partial<Record<NodeType, string>> = {
    ai: `{ "provider": "openai", "model": "gpt-4o", "user_template": "{{trigger.input}}" }`,
    agent: `{ "role": "Researcher", "model": "gpt-4o", "max_iterations": 5, "budget_cents": 100, "tools": [], "handoff": "next_step_key" }`,
    http: `{ "url": "https://example.com/api", "method": "POST" }`,
    transform: `{ "output_mapping": { "result": "{{step_name.field}}" } }`,
    branch: `{ "branches": [{ "condition": "trigger.score > 80", "next_step_key": "..." }], "default_next_step_key": null }`,
    delay: `{ "duration_seconds": 3600 }`,
    connector: `{ "connector_id": "gmail", "account_id": "<uuid>", "action": "send_email", "params": {} }`,
  };
  const hint = hints[type];
  if (!hint) return null;
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
      <p className="text-[10px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">Example config</p>
      <pre className="text-[10px] text-slate-600 whitespace-pre-wrap break-all">{hint}</pre>
    </div>
  );
}
