"use client";

import { createContext, useContext, useState, useCallback, ReactNode, useEffect } from "react";
import { cn } from "./cn";

type ToastType = "success" | "error" | "default";
interface ToastItem { id: number; message: string; type: ToastType }

const Ctx = createContext<(message: string, type?: ToastType) => void>(() => {});

let _id = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const add = useCallback((message: string, type: ToastType = "default") => {
    const id = ++_id;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  return (
    <Ctx.Provider value={add}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-72" aria-live="polite">
        {toasts.map((t) => (
          <Toast key={t.id} item={t} onDismiss={() => setToasts((p) => p.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  useEffect(() => { const t = setTimeout(onDismiss, 3500); return () => clearTimeout(t); }, [onDismiss]);
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3 shadow-md text-sm",
        item.type === "success" && "bg-green-50 border-green-200 text-green-800",
        item.type === "error" && "bg-red-50 border-red-200 text-red-700",
        item.type === "default" && "bg-background border-border text-foreground",
      )}
    >
      <span className="flex-1">{item.message}</span>
      <button onClick={onDismiss} className="text-current opacity-50 hover:opacity-100 leading-none">✕</button>
    </div>
  );
}

export function useToast() {
  return useContext(Ctx);
}
