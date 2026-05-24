import { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export interface Breadcrumb {
  label: string;
  href?: string;
}

interface TopbarProps {
  user: { email: string; role: string };
  sidebarToggle?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  notificationBell?: ReactNode;
  /** Renders a "Test mode" chip — pass true when STRIPE_SECRET_KEY starts with "sk_test_" */
  testMode?: boolean;
  actions?: ReactNode;
}

export function Topbar({ user, sidebarToggle, breadcrumbs, notificationBell, testMode, actions }: TopbarProps) {
  return (
    <header
      className={cn(
        "h-[var(--topbar-h,56px)] shrink-0",
        "border-b border-border bg-background",
        "flex items-center gap-3 px-4",
      )}
    >
      {sidebarToggle}

      {/* Breadcrumbs */}
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav className="flex items-center gap-1 flex-1 min-w-0" aria-label="Breadcrumb">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground text-[11px]">/</span>}
              {crumb.href ? (
                <a
                  href={crumb.href}
                  className="text-[13px] text-muted-foreground hover:text-foreground transition-colors truncate"
                >
                  {crumb.label}
                </a>
              ) : (
                <span className="text-[13px] font-medium text-foreground truncate">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : (
        <div className="flex-1" />
      )}

      <div className="flex items-center gap-2 shrink-0">
        {testMode && (
          <span className="hidden sm:inline-flex items-center gap-1 rounded-full border border-warn/30 bg-warn-soft px-2 py-0.5 text-[10px] font-semibold text-warn uppercase tracking-wide">
            Test mode
          </span>
        )}

        {notificationBell}

        <span className="text-[12px] text-muted-foreground hidden md:block truncate max-w-[160px]">
          {user.email}
        </span>

        {actions}

        <form action="/api/auth/signout" method="POST">
          <button
            type="submit"
            className="text-[12px] text-muted-foreground hover:text-bad transition-colors"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
