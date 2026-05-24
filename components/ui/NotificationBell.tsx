"use client";

import { useState, useRef, useEffect, ReactNode } from "react";
import { cn } from "./cn";

export interface Notification {
  id: string;
  title: string;
  body?: string;
  read: boolean;
  time?: string;
  href?: string;
}

interface NotificationBellProps {
  notifications: Notification[];
  onMarkAllRead?: () => void;
  className?: string;
}

export function NotificationBell({
  notifications,
  onMarkAllRead,
  className,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    if (open) window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative w-8 h-8 flex items-center justify-center rounded-lg",
          "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
          open && "bg-muted text-foreground",
        )}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        aria-expanded={open}
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M7.5 1.5a4 4 0 0 1 4 4v2.5l1 2H2.5l1-2V5.5a4 4 0 0 1 4-4Z" />
          <path d="M6 11.5a1.5 1.5 0 0 0 3 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[14px] h-3.5 px-0.5 rounded-full bg-bad text-[9px] font-bold text-white flex items-center justify-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className={cn(
            "absolute right-0 top-full mt-2 w-72 rounded-xl border border-border bg-surface",
            "shadow-[var(--shadow-overlay)] z-50 overflow-hidden",
          )}
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <span className="text-xs font-semibold text-foreground">Notifications</span>
            {unread > 0 && onMarkAllRead && (
              <button
                type="button"
                onClick={() => { onMarkAllRead(); setOpen(false); }}
                className="text-[11px] text-primary hover:text-accent-ink transition-colors"
              >
                Mark all read
              </button>
            )}
          </div>

          {notifications.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-muted-foreground">
              No notifications
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {notifications.map((n) => (
                <NotificationItem key={n.id} notification={n} onClose={() => setOpen(false)} />
              ))}
            </div>
          )}

          <div className="px-4 py-2 border-t border-border">
            <a
              href="/settings/notifications"
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setOpen(false)}
            >
              Notification settings →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationItem({
  notification: n,
  onClose,
}: {
  notification: Notification;
  onClose: () => void;
}) {
  const inner: ReactNode = (
    <div className={cn(
      "px-4 py-3 border-b border-border-soft last:border-0 hover:bg-muted/40 transition-colors",
      !n.read && "bg-accent-soft/50",
    )}>
      <div className="flex items-start gap-2">
        {!n.read && (
          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary shrink-0" aria-hidden="true" />
        )}
        <div className={cn("flex-1 min-w-0", n.read && "pl-3.5")}>
          <p className="text-[12px] font-medium text-foreground leading-snug">{n.title}</p>
          {n.body && <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{n.body}</p>}
          {n.time && <p className="text-[10px] text-muted-2 mt-1">{n.time}</p>}
        </div>
      </div>
    </div>
  );

  if (n.href) {
    return <a href={n.href} onClick={onClose} className="block">{inner}</a>;
  }
  return <div>{inner}</div>;
}
