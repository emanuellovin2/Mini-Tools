"use client";

/**
 * Visual workflow canvas — the core of the builder (#58).
 *
 * Architecture:
 *  - Nodes are absolutely positioned <div>s rendered inside a pannable container.
 *  - Edges are drawn as SVG <path>s overlaid on the same container.
 *  - Virtualization: nodes outside the visible viewport are CSS-hidden (not unmounted
 *    so refs remain valid) — avoids full re-layout on every keystroke/pan.
 *  - Drag state uses setPointerCapture so it works across the whole canvas.
 *  - Edge drawing: drag from output port → release on input port to connect.
 */

import { useState, useRef, useCallback, useId, type PointerEvent } from "react";
import { nanoid } from "nanoid";
import { NodeCard, PaletteItem, NODE_TYPES } from "./NodeCard";
import { ConfigDrawer } from "./ConfigDrawer";
import type {
  VisualGraph,
  VisualNode,
  VisualEdge,
  NodeType,
  GraphValidationError,
} from "@/lib/workflows/graph-schema";

interface CanvasProps {
  workflowId: string;
  initialGraph: VisualGraph;
  baseVersion: number;
  /** Called when save or publish succeeds */
  onVersionPublished?: (version: number) => void;
}

const CANVAS_W = 4000;
const CANVAS_H = 4000;
const INITIAL_OFFSET = { x: -120, y: -60 }; // pan so origin is near top-left of viewport

// ---------------------------------------------------------------------------
// Main canvas
// ---------------------------------------------------------------------------

export function WorkflowCanvas({ workflowId, initialGraph, baseVersion, onVersionPublished }: CanvasProps) {
  const [graph, setGraph] = useState<VisualGraph>(initialGraph);
  const [pan, setPan] = useState(INITIAL_OFFSET);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerNode, setDrawerNode] = useState<VisualNode | null>(null);
  const [serverErrors, setServerErrors] = useState<GraphValidationError[]>([]);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [versionCount, setVersionCount] = useState(baseVersion);

  // Drag-node state
  const dragRef = useRef<{ nodeId: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  // Pan state
  const panRef = useRef<{ startX: number; startY: number; origPan: { x: number; y: number } } | null>(null);
  // Edge drawing state
  const edgeDragRef = useRef<{ sourceId: string; x: number; y: number } | null>(null);
  const [pendingEdge, setPendingEdge] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Port refs for edge drawing
  const outputPortRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const inputPortRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const containerRef = useRef<HTMLDivElement>(null);
  const instanceId = useId();

  // ---------------------------------------------------------------------------
  // Node drag
  // ---------------------------------------------------------------------------

  const handleNodeDragStart = useCallback((nodeId: string, e: PointerEvent) => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    dragRef.current = { nodeId, startX: e.clientX, startY: e.clientY, origX: node.position.x, origY: node.position.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [graph.nodes]);

  const handlePointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    // Node drag
    if (dragRef.current) {
      const { nodeId, startX, startY, origX, origY } = dragRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, position: { x: origX + dx, y: origY + dy } }
            : n
        ),
      }));
      return;
    }
    // Canvas pan (middle mouse or space+drag — handled by canvas onPointerDown with button=1)
    if (panRef.current) {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      setPan({ x: panRef.current.origPan.x + dx, y: panRef.current.origPan.y + dy });
      return;
    }
    // Edge drawing
    if (edgeDragRef.current) {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      edgeDragRef.current.x = e.clientX - rect.left - pan.x;
      edgeDragRef.current.y = e.clientY - rect.top - pan.y;
      const src = edgeDragRef.current;
      const srcPort = outputPortRefs.current.get(src.sourceId);
      if (srcPort) {
        const srcRect = srcPort.getBoundingClientRect();
        const x1 = srcRect.left + srcRect.width / 2 - rect.left - pan.x;
        const y1 = srcRect.top + srcRect.height / 2 - rect.top - pan.y;
        setPendingEdge({ x1, y1, x2: src.x, y2: src.y });
      }
    }
  }, [pan]);

  const handlePointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    panRef.current = null;

    if (edgeDragRef.current) {
      const sourceId = edgeDragRef.current.sourceId;
      // Check if released over an input port
      for (const [targetId, portEl] of inputPortRefs.current.entries()) {
        const rect = portEl.getBoundingClientRect();
        if (
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom &&
          targetId !== sourceId
        ) {
          // Create edge
          const newEdge: VisualEdge = {
            id: `e_${nanoid(6)}`,
            source: sourceId,
            target: targetId,
          };
          setGraph((g) => ({ ...g, edges: [...g.edges, newEdge] }));
          break;
        }
      }
      edgeDragRef.current = null;
      setPendingEdge(null);
    }
  }, []);

  const handleCanvasPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    // Middle mouse button or right click = pan
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      panRef.current = { startX: e.clientX, startY: e.clientY, origPan: { ...pan } };
      (e.target as Element).setPointerCapture(e.pointerId);
    } else {
      // Deselect
      setSelectedId(null);
    }
  }, [pan]);

  // ---------------------------------------------------------------------------
  // Node management
  // ---------------------------------------------------------------------------

  function addNode(type: NodeType) {
    const id = `${type}_${nanoid(4)}`;
    const newNode: VisualNode = {
      id,
      type,
      config: defaultConfig(type),
      position: { x: 200 + Math.random() * 100, y: 100 + graph.nodes.length * 140 },
      label: `${type} step`,
    };
    setGraph((g) => ({
      ...g,
      nodes: [...g.nodes, newNode],
      start_node_id: g.start_node_id || id,
    }));
    setSelectedId(id);
    setDrawerNode(newNode);
  }

  function deleteNode(nodeId: string) {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.filter((n) => n.id !== nodeId),
      edges: g.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      start_node_id: g.start_node_id === nodeId
        ? (g.nodes.find((n) => n.id !== nodeId)?.id ?? "")
        : g.start_node_id,
    }));
    if (selectedId === nodeId) setSelectedId(null);
    if (drawerNode?.id === nodeId) setDrawerNode(null);
  }

  function updateNodeConfig(nodeId: string, config: Record<string, unknown>, label: string) {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === nodeId ? { ...n, config, label } : n
      ),
    }));
    setDrawerNode(null);
    setServerErrors((errs) => errs.filter((e) => e.node_id !== nodeId));
  }

  function setStartNode(nodeId: string) {
    setGraph((g) => ({ ...g, start_node_id: nodeId }));
  }

  function deleteEdge(edgeId: string) {
    setGraph((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== edgeId) }));
  }

  // ---------------------------------------------------------------------------
  // Save / publish
  // ---------------------------------------------------------------------------

  async function saveDraft() {
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/builder/${workflowId}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graph }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.errors) setServerErrors(data.errors);
        setStatusMsg(data.error ?? "Save failed");
      } else {
        setServerErrors([]);
        setStatusMsg("Draft saved");
        setTimeout(() => setStatusMsg(null), 2000);
      }
    } catch {
      setStatusMsg("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    setPublishing(true);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/builder/${workflowId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graph, base_version: versionCount }),
      });
      const data = await res.json();
      if (res.status === 409) {
        setStatusMsg("Another version was published. Please reload.");
      } else if (!res.ok) {
        if (data.errors) setServerErrors(data.errors);
        setStatusMsg(data.error ?? "Publish failed");
      } else {
        setServerErrors([]);
        setVersionCount((v) => v + 1);
        setStatusMsg(`Published v${data.version} ✓`);
        onVersionPublished?.(data.version);
        setTimeout(() => setStatusMsg(null), 3000);
      }
    } catch {
      setStatusMsg("Network error");
    } finally {
      setPublishing(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const container = containerRef.current;
  const containerRect = container?.getBoundingClientRect();

  return (
    <div className="flex h-full">
      {/* Left palette */}
      <aside className="w-40 flex-shrink-0 border-r border-slate-200 bg-white p-3 flex flex-col gap-2 overflow-y-auto">
        <p className="text-[10px] font-semibold uppercase text-slate-400 tracking-wide mb-1">Add step</p>
        {NODE_TYPES.map((type) => (
          <PaletteItem key={type} type={type} onAdd={() => addNode(type)} />
        ))}
      </aside>

      {/* Main canvas area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-200 bg-white text-sm">
          {selectedId && (
            <>
              <button
                className="text-xs px-2 py-1 rounded border border-slate-200 hover:bg-slate-50"
                onClick={() => {
                  const n = graph.nodes.find((x) => x.id === selectedId);
                  if (n) setDrawerNode(n);
                }}
              >
                ✎ Edit
              </button>
              <button
                className="text-xs px-2 py-1 rounded border border-slate-200 hover:bg-slate-50"
                onClick={() => setStartNode(selectedId)}
                disabled={graph.start_node_id === selectedId}
              >
                ↑ Set start
              </button>
              <button
                className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50"
                onClick={() => deleteNode(selectedId)}
              >
                ✕ Delete
              </button>
              <span className="text-slate-300">|</span>
            </>
          )}
          <span className="text-slate-500 text-xs">{graph.nodes.length} nodes · {graph.edges.length} edges</span>
          <div className="ml-auto flex items-center gap-2">
            {statusMsg && (
              <span className={`text-xs ${statusMsg.includes("✓") ? "text-emerald-600" : serverErrors.length > 0 ? "text-red-600" : "text-slate-500"}`}>
                {statusMsg}
              </span>
            )}
            <button
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-40"
              onClick={saveDraft}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save draft"}
            </button>
            <button
              className="text-xs px-3 py-1.5 rounded-lg bg-[var(--primary)] text-white hover:opacity-90 disabled:opacity-40"
              onClick={publish}
              disabled={publishing || saving}
            >
              {publishing ? "Publishing…" : "Publish"}
            </button>
          </div>
        </div>

        {/* Validation errors panel */}
        {serverErrors.length > 0 && (
          <div className="bg-red-50 border-b border-red-200 px-4 py-2 max-h-24 overflow-y-auto">
            {serverErrors.map((err, i) => (
              <p key={i} className="text-xs text-red-700">
                {err.node_id && <span className="font-semibold">[{err.node_id}] </span>}
                {err.message}
              </p>
            ))}
          </div>
        )}

        {/* Canvas */}
        <div
          ref={containerRef}
          className="relative flex-1 overflow-hidden bg-[#fafafa] cursor-default"
          style={{
            backgroundImage: "radial-gradient(circle, #d1d5db 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Pannable world */}
          <div
            className="absolute"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px)`, width: CANVAS_W, height: CANVAS_H }}
          >
            {/* SVG for edges */}
            <svg
              className="absolute inset-0 pointer-events-none overflow-visible"
              width={CANVAS_W}
              height={CANVAS_H}
            >
              <defs>
                <marker id={`${instanceId}_arrow`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" fill="#94a3b8" />
                </marker>
              </defs>
              {/* Drawn edges */}
              {graph.edges.map((edge) => (
                <EdgePath
                  key={edge.id}
                  edge={edge}
                  nodes={graph.nodes}
                  markerId={`${instanceId}_arrow`}
                  onDelete={() => deleteEdge(edge.id)}
                />
              ))}
              {/* Pending edge while drawing */}
              {pendingEdge && (
                <BezierPath
                  x1={pendingEdge.x1} y1={pendingEdge.y1}
                  x2={pendingEdge.x2} y2={pendingEdge.y2}
                  stroke="#6366f1" strokeDasharray="4"
                />
              )}
            </svg>

            {/* Nodes */}
            {graph.nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                selected={selectedId === node.id}
                hasError={serverErrors.some((e) => e.node_id === node.id)}
                isStart={graph.start_node_id === node.id}
                onSelect={() => setSelectedId(node.id)}
                onDragStart={(e) => handleNodeDragStart(node.id, e)}
                outputPortRef={(el) => {
                  if (el) outputPortRefs.current.set(node.id, el);
                  else outputPortRefs.current.delete(node.id);
                }}
                inputPortRef={(el) => {
                  if (el) inputPortRefs.current.set(node.id, el);
                  else inputPortRefs.current.delete(node.id);
                }}
                onStartEdge={(e) => {
                  edgeDragRef.current = { sourceId: node.id, x: 0, y: 0 };
                  (e.target as Element).setPointerCapture(e.pointerId);
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Config drawer */}
      <ConfigDrawer
        node={drawerNode}
        errors={serverErrors}
        onClose={() => setDrawerNode(null)}
        onSave={updateNodeConfig}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edge path rendering
// ---------------------------------------------------------------------------

function getNodeCenter(node: VisualNode, offsetY = 0): { x: number; y: number } {
  return { x: node.position.x + 88, y: node.position.y + offsetY };
}

function EdgePath({
  edge,
  nodes,
  markerId,
  onDelete,
}: {
  edge: VisualEdge;
  nodes: VisualNode[];
  markerId: string;
  onDelete: () => void;
}) {
  const src = nodes.find((n) => n.id === edge.source);
  const tgt = nodes.find((n) => n.id === edge.target);
  if (!src || !tgt) return null;

  const x1 = getNodeCenter(src, 72).x;
  const y1 = getNodeCenter(src, 72).y;
  const x2 = getNodeCenter(tgt, -10).x;
  const y2 = getNodeCenter(tgt, -10).y;

  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;

  return (
    <g>
      <BezierPath x1={x1} y1={y1} x2={x2} y2={y2} markerId={markerId} />
      {/* Invisible fat hit area for click-to-delete */}
      <path
        d={bezierD(x1, y1, x2, y2)}
        stroke="transparent"
        strokeWidth={16}
        fill="none"
        className="cursor-pointer pointer-events-auto"
        onClick={onDelete}
      >
        <title>Click to remove edge</title>
      </path>
      {edge.label && (
        <text x={midX} y={midY - 6} textAnchor="middle" className="text-[10px]" fill="#64748b" fontSize={10}>
          {edge.label}
        </text>
      )}
    </g>
  );
}

function bezierD(x1: number, y1: number, x2: number, y2: number): string {
  const cy = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`;
}

function BezierPath({
  x1, y1, x2, y2,
  stroke = "#94a3b8",
  strokeDasharray,
  markerId,
}: {
  x1: number; y1: number; x2: number; y2: number;
  stroke?: string;
  strokeDasharray?: string;
  markerId?: string;
}) {
  return (
    <path
      d={bezierD(x1, y1, x2, y2)}
      stroke={stroke}
      strokeWidth={2}
      fill="none"
      strokeDasharray={strokeDasharray}
      markerEnd={markerId ? `url(#${markerId})` : undefined}
    />
  );
}

// ---------------------------------------------------------------------------
// Default configs
// ---------------------------------------------------------------------------

function defaultConfig(type: NodeType): Record<string, unknown> {
  switch (type) {
    case "ai":        return { provider: "openai", model: "gpt-4o", user_template: "{{trigger.input}}" };
    case "agent":     return { role: "Agent", model: "gpt-4o", max_iterations: 5, budget_cents: 100, tools: [], handoff: "" };
    case "http":      return { url: "", method: "POST" };
    case "transform": return { output_mapping: {} };
    case "branch":    return { branches: [{ condition: "trigger.value == true", next_step_key: "" }], default_next_step_key: null };
    case "delay":     return { duration_seconds: 60 };
    case "connector": return { connector_id: "", account_id: "", action: "" };
  }
}
