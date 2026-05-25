import { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import Link from "next/link";

export interface Breadcrumb {
  label: string;
  href?: string;
}

interface TopbarProps {
  user: { email: string; role: string };
  sidebarToggle?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  notificationBell?: ReactNode;
  testMode?: boolean;
  actions?: ReactNode;
}

export function Topbar({
  user,
  sidebarToggle,
  breadcrumbs,
  notificationBell,
  testMode,
  actions,
}: TopbarProps) {
  return (
    <header
      className={cn(
        "h-[var(--topbar-h,60px)] shrink-0 bg-surface",
        "flex items-center gap-3 px-5",
        "shadow-[inset_0_-1px_0_hsl(var(--border))]",
      )}
    >
      {sidebarToggle}

      {/* Breadcrumbs */}
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav className="flex items-center gap-1.5 flex-1 min-w-0" aria-label="Breadcrumb">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && (
                <svg width="12" height="12" viewBox="0 0 12 12" className="text-border shrink-0">
                  <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors truncate"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-sm font-medium text-foreground truncate">
                  {crumb.label}
                </span>
              )}
            </span>
          ))}
        </nav>
      ) : (
        <div className="flex-1" />
      )}

      {/* Right side */}
      <div className="flex items-center gap-3 shrink-0">
        {testMode && (
          <span className="hidden sm:inline-flex items-center gap-1 rounded-full border border-warn/30 bg-warn-soft px-2.5 py-1 text-xs font-medium text-warn">
            Test mode
          </span>
        )}

        {notificationBell}
        {actions}

        <div className="flex items-center gap-2 border-l border-border pl-3">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white shrink-0"
            style={{ background: "hsl(var(--primary))" }}
          >
            {(user.email ?? "U")[0].toUpperCase()}
          </div>
          <span className="text-sm text-muted-foreground hidden md:block truncate max-w-[140px]">
            {user.email}
          </span>
        </div>

        <form action="/api/auth/signout" method="POST">
          <button
            type="submit"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
