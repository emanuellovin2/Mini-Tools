"use client";

import { NODE_TYPES, type NodeType, type VisualNode } from "@/lib/workflows/graph-schema";
import { cn } from "@/components/ui/cn";

const NODE_COLORS: Record<NodeType, string> = {
  ai:        "bg-violet-50 border-violet-300 text-violet-800",
  agent:     "bg-purple-50 border-purple-400 text-purple-900",
  http:      "bg-sky-50 border-sky-300 text-sky-800",
  transform: "bg-amber-50 border-amber-300 text-amber-800",
  branch:    "bg-orange-50 border-orange-300 text-orange-800",
  delay:     "bg-slate-50 border-slate-300 text-slate-700",
  connector: "bg-emerald-50 border-emerald-300 text-emerald-800",
};

const NODE_ICONS: Record<NodeType, string> = {
  ai:        "✦",
  agent:     "◈",
  http:      "⟳",
  transform: "⇌",
  branch:    "⑂",
  delay:     "⏱",
  connector: "⊕",
};

interface NodeCardProps {
  node: VisualNode;
  selected: boolean;
  hasError: boolean;
  isStart: boolean;
  onSelect: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  /** Port refs for edge drawing */
  outputPortRef: (el: HTMLDivElement | null) => void;
  inputPortRef: (el: HTMLDivElement | null) => void;
  onStartEdge: (e: React.PointerEvent) => void;
}

export function NodeCard({
  node,
  selected,
  hasError,
  isStart,
  onSelect,
  onDragStart,
  outputPortRef,
  inputPortRef,
  onStartEdge,
}: NodeCardProps) {
  const colorClass = NODE_COLORS[node.type] ?? "bg-white border-slate-300 text-slate-700";
  const icon = NODE_ICONS[node.type] ?? "●";
  const label = node.label ?? node.id;

  return (
    <div
      className={cn(
        "absolute select-none rounded-xl border-2 shadow-sm cursor-pointer transition-shadow w-44",
        colorClass,
        selected && "ring-2 ring-offset-1 ring-[var(--primary)] shadow-md",
        hasError && "ring-2 ring-red-400",
      )}
      style={{ left: node.position.x, top: node.position.y, touchAction: "none" }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
        onDragStart(e);
      }}
    >
      {/* Input port */}
      <div
        ref={inputPortRef}
        className="absolute -top-2.5 left-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 border-white bg-slate-400 cursor-crosshair z-10"
        title="Input"
      />

      <div className="px-3 pt-4 pb-3">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-sm font-semibold leading-none" aria-hidden>{icon}</span>
          <span className="text-[11px] font-medium uppercase tracking-wide opacity-70">{node.type}</span>
          {isStart && (
            <span className="ml-auto text-[9px] font-semibold bg-white/70 px-1 rounded">START</span>
          )}
        </div>
        <p className="text-xs font-medium truncate" title={label}>{label}</p>
        {hasError && (
          <p className="text-[10px] text-red-600 mt-1">⚠ validation error</p>
        )}
      </div>

      {/* Output port */}
      <div
        ref={outputPortRef}
        className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 border-white bg-slate-500 cursor-crosshair z-10 hover:bg-[color:var(--primary)]"
        title="Drag to connect"
        onPointerDown={(e) => {
          e.stopPropagation();
          onStartEdge(e);
        }}
      />
    </div>
  );
}

/** Palette item — shown in the sidebar for drag-onto-canvas. */
export function PaletteItem({ type, onAdd }: { type: NodeType; onAdd: () => void }) {
  const colorClass = NODE_COLORS[type];
  const icon = NODE_ICONS[type];
  return (
    <button
      className={cn(
        "flex items-center gap-2 w-full px-3 py-2 rounded-lg border text-left text-xs font-medium transition-opacity hover:opacity-80",
        colorClass
      )}
      onClick={onAdd}
      type="button"
    >
      <span className="text-sm">{icon}</span>
      <span className="capitalize">{type}</span>
    </button>
  );
}

export { NODE_TYPES };
