"use client";

import { useEffect, useRef, ReactNode, useCallback } from "react";
import { cn } from "./cn";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}

export function Drawer({ open, onClose, title, children, footer, width = "w-[520px]" }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const handleKey = useCallback(
    (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); },
    [onClose],
  );

  useEffect(() => {
    if (open) {
      window.addEventListener("keydown", handleKey);
      closeBtnRef.current?.focus();
      document.body.style.overflow = "hidden";
    }
    return () => {
      window.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [open, handleKey]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className={cn(
          "relative ml-auto h-full bg-surface flex flex-col",
          "shadow-[var(--shadow-drawer)] animate-in slide-in-from-right",
          "max-sm:w-full",
          width,
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          {title && <h2 className="text-sm font-semibold text-foreground">{title}</h2>}
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            className={cn(
              "ml-auto w-7 h-7 rounded flex items-center justify-center",
              "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
            )}
            aria-label="Close drawer"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75">
              <line x1="1" y1="1" x2="13" y2="13" /><line x1="13" y1="1" x2="1" y2="13" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="shrink-0 px-5 py-4 border-t border-border bg-muted/30">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
