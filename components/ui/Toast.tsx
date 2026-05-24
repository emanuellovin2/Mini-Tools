"use client";

import {
  createContext, useContext, useState, useCallback, ReactNode, useEffect
} from "react";
import { cn } from "./cn";

type ToastType = "success" | "error" | "default" | "ok" | "warn" | "bad";
interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  undo?: () => void;
}

type AddToast = (message: string, opts?: { type?: ToastType; undo?: () => void }) => void;

const Ctx = createContext<AddToast>(() => {});
let _id = 0;
const DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const add = useCallback<AddToast>((message, opts = {}) => {
    const id = ++_id;
    setToasts((prev) => [...prev, { id, message, type: opts.type ?? "default", undo: opts.undo }]);
    if (!opts.undo) {
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), DISMISS_MS);
    }
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <Ctx.Provider value={add}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-72"
        aria-live="polite"
        aria-label="Notifications"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ToastItem({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const hasUndo = !!item.undo;

  useEffect(() => {
    if (hasUndo) return;
    const t = setTimeout(onDismiss, DISMISS_MS);
    return () => clearTimeout(t);
  }, [onDismiss, hasUndo]);

  const [undoTimer, setUndoTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  function handleUndo() {
    if (undoTimer) clearTimeout(undoTimer);
    item.undo?.();
    onDismiss();
  }

  useEffect(() => {
    if (!hasUndo) return;
    const t = setTimeout(onDismiss, DISMISS_MS);
    setUndoTimer(t);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typeClass = {
    ok: "bg-ok-soft border-ok/20 text-ok",
    success: "bg-ok-soft border-ok/20 text-ok",
    warn: "bg-warn-soft border-warn/20 text-warn",
    bad: "bg-bad-soft border-bad/20 text-bad",
    error: "bg-bad-soft border-bad/20 text-bad",
    default: "bg-surface border-border text-foreground",
  }[item.type];

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border px-3.5 py-3",
        "shadow-[var(--shadow-md)] text-[12px]",
        typeClass,
      )}
      role="status"
    >
      <span className="flex-1 leading-snug">{item.message}</span>
      {hasUndo && (
        <button
          onClick={handleUndo}
          className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline"
        >
          Undo
        </button>
      )}
      <button
        onClick={onDismiss}
        className="shrink-0 opacity-50 hover:opacity-100 leading-none"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

export function useToast() {
  return useContext(Ctx);
}
