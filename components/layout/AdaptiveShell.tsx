"use client";

/**
 * Adaptive shell — toggles between Chat mode (gateway) and Canvas mode (builder).
 *
 * Chat mode: sends messages to /api/gateway/[provider] for the selected deployment.
 * Canvas mode: renders the visual workflow builder.
 *
 * Both modes share the same org/deployment context. The mode toggle is a view
 * switch — no navigation, no separate apps.
 *
 * IDE/spreadsheet modes are explicitly deferred (#58 scope).
 */

import { useState, useRef, useEffect } from "react";
import { WorkflowCanvas } from "@/components/builder/Canvas";
import type { VisualGraph } from "@/lib/workflows/graph-schema";

type ShellMode = "chat" | "canvas";

interface AdaptiveShellProps {
  /** Deployment ID for chat mode (gateway target). */
  deploymentId?: string | null;
  /** Workflow ID for canvas mode. */
  workflowId?: string | null;
  /** Pre-loaded graph for canvas (pass when opening builder). */
  initialGraph?: VisualGraph | null;
  baseVersion?: number;
  defaultMode?: ShellMode;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function AdaptiveShell({
  deploymentId,
  workflowId,
  initialGraph,
  baseVersion = 0,
  defaultMode = "chat",
}: AdaptiveShellProps) {
  const [mode, setMode] = useState<ShellMode>(
    workflowId && !deploymentId ? "canvas" : defaultMode
  );

  return (
    <div className="flex flex-col h-full bg-white rounded-xl border border-slate-200 overflow-hidden">
      {/* Mode toggle bar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-200 bg-slate-50">
        <ModeTab mode="chat" current={mode} label="Chat" icon="◉" onClick={() => setMode("chat")} disabled={!deploymentId} />
        <ModeTab mode="canvas" current={mode} label="Canvas" icon="⬡" onClick={() => setMode("canvas")} disabled={!workflowId} />
        <div className="ml-auto text-[10px] text-slate-400 select-none">
          {mode === "chat" ? (deploymentId ? `deployment ${deploymentId.slice(0, 8)}…` : "no deployment") : "visual builder"}
        </div>
      </div>

      {/* Mode content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {mode === "chat" && deploymentId ? (
          <ChatPanel deploymentId={deploymentId} />
        ) : mode === "canvas" && workflowId && initialGraph ? (
          <WorkflowCanvas
            workflowId={workflowId}
            initialGraph={initialGraph}
            baseVersion={baseVersion}
          />
        ) : (
          <EmptyState mode={mode} hasDeployment={!!deploymentId} hasWorkflow={!!workflowId} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode tab button
// ---------------------------------------------------------------------------

function ModeTab({
  mode,
  current,
  label,
  icon,
  onClick,
  disabled,
}: {
  mode: ShellMode;
  current: ShellMode;
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const active = mode === current;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
        active
          ? "bg-white border border-slate-200 text-slate-800 shadow-sm"
          : "text-slate-500 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed",
      ].join(" ")}
    >
      <span aria-hidden>{icon}</span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Chat panel — conversational gateway surface
// ---------------------------------------------------------------------------

function ChatPanel({ deploymentId }: { deploymentId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setError(null);
    const userMsg: ChatMessage = { role: "user", content: text };
    setMessages((m) => [...m, userMsg]);
    setSending(true);

    try {
      const res = await fetch(`/api/gateway/openai?deployment_id=${deploymentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [...messages, userMsg].map((m) => ({ role: m.role, content: m.content })),
          stream: false,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content ?? "(no response)";
      setMessages((m) => [...m, { role: "assistant", content: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-slate-400 text-sm mt-12 select-none">
            <div className="text-2xl mb-2">◉</div>
            <p>Chat with this deployment</p>
            <p className="text-xs mt-1 opacity-70">Powered by the AI gateway · instructions + knowledge resolved automatically</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatBubble key={i} message={msg} />
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-slate-100 rounded-xl px-4 py-2.5 text-sm text-slate-500 animate-pulse">
              Thinking…
            </div>
          </div>
        )}
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-slate-200 px-4 py-3">
        <div className="flex gap-2">
          <textarea
            className="flex-1 resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)] min-h-[40px] max-h-28"
            rows={1}
            placeholder="Type a message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
          />
          <button
            type="button"
            disabled={!input.trim() || sending}
            onClick={sendMessage}
            className="px-3 py-2 rounded-lg bg-[var(--primary)] text-white text-sm disabled:opacity-40 hover:opacity-90 self-end"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[80%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap",
          isUser
            ? "bg-[var(--primary)] text-white"
            : "bg-slate-100 text-slate-800",
        ].join(" ")}
      >
        {message.content}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({
  mode,
  hasDeployment,
  hasWorkflow,
}: {
  mode: ShellMode;
  hasDeployment: boolean;
  hasWorkflow: boolean;
}) {
  return (
    <div className="flex items-center justify-center h-full text-slate-400 text-sm text-center px-8">
      {mode === "chat" && !hasDeployment && (
        <p>No deployment selected. Choose a deployment to start chatting.</p>
      )}
      {mode === "canvas" && !hasWorkflow && (
        <p>No workflow selected. Open a workflow to use the visual builder.</p>
      )}
    </div>
  );
}
