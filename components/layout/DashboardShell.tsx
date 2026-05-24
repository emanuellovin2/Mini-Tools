"use client";

import { useState, useEffect, ReactNode, useCallback } from "react";
import { Sidebar, type NavItem } from "./Sidebar";
import { Topbar, type Breadcrumb } from "./Topbar";
import { cn } from "@/components/ui/cn";

interface DashboardShellProps {
  nav: NavItem[];
  user: { email: string; role: string };
  children: ReactNode;
  breadcrumbs?: Breadcrumb[];
  testMode?: boolean;
  notificationBell?: ReactNode;
}

export function DashboardShell({
  nav,
  user,
  children,
  breadcrumbs,
  testMode,
  notificationBell,
}: DashboardShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileOpen(false);
  }, []);

  const closeMobile = useCallback(() => setMobileOpen(false), []);

  const HamburgerButton = (
    <button
      onClick={() => {
        // On mobile: toggle overlay. On desktop: toggle collapsed.
        if (window.innerWidth < 768) {
          setMobileOpen((o) => !o);
        } else {
          setCollapsed((c) => !c);
        }
      }}
      className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-md hover:bg-muted"
      aria-label="Toggle sidebar"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <line x1="1" y1="4" x2="15" y2="4" />
        <line x1="1" y1="8" x2="15" y2="8" />
        <line x1="1" y1="12" x2="15" y2="12" />
      </svg>
    </button>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <div className="hidden md:flex flex-shrink-0 h-full">
        <Sidebar
          nav={nav}
          collapsed={collapsed}
          role={user.role}
          userEmail={user.email}
        />
      </div>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={closeMobile}
            aria-hidden="true"
          />
          <div className={cn(
            "fixed left-0 top-0 z-50 h-full md:hidden",
            "shadow-[var(--shadow-overlay)]",
          )}>
            <Sidebar
              nav={nav}
              collapsed={false}
              role={user.role}
              userEmail={user.email}
            />
          </div>
        </>
      )}

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Topbar
          user={user}
          sidebarToggle={HamburgerButton}
          breadcrumbs={breadcrumbs}
          testMode={testMode}
          notificationBell={notificationBell}
        />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
