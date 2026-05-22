"use client";

import { useEffect, useRef, ReactNode } from "react";
import { cn } from "./cn";
import { Button } from "./Button";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmVariant?: "default" | "destructive";
  onConfirm: () => void;
  isPending?: boolean;
  children?: ReactNode;
}

export function Modal({
  open, onClose, title, description, confirmLabel = "Confirm",
  confirmVariant = "default", onConfirm, isPending, children,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) el.showModal();
    else el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event) => { e.preventDefault(); onClose(); };
    el.addEventListener("cancel", handler);
    return () => el.removeEventListener("cancel", handler);
  }, [onClose]);

  return (
    <dialog ref={ref} className="rounded-xl w-full max-w-sm bg-background shadow-lg p-6 m-auto">
      <h2 className="text-base font-semibold mb-1">{title}</h2>
      {description && <p className="text-sm text-muted-foreground mb-4">{description}</p>}
      {children}
      <div className={cn("flex justify-end gap-2", (description || children) ? "mt-4" : "mt-4")}>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={isPending}>Cancel</Button>
        <Button variant={confirmVariant} size="sm" onClick={onConfirm} disabled={isPending}>
          {isPending ? "Working…" : confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
