"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";

export interface NavItem {
  label: string;
  href: string;
  icon?: React.ReactNode;
}

interface SidebarProps {
  nav: NavItem[];
  collapsed?: boolean;
  role?: string;
  userEmail?: string;
}

export function Sidebar({ nav, collapsed, role, userEmail }: SidebarProps) {
  const pathname = usePathname();

  return (
    <nav
      className={cn(
        "flex flex-col h-full bg-surface border-r border-border",
        "transition-[width] duration-200 overflow-hidden",
        collapsed ? "w-14" : "w-[var(--sidebar-w,220px)]",
      )}
      aria-label="Sidebar navigation"
    >
      {/* Brand */}
      <div
        className={cn(
          "flex items-center h-[var(--topbar-h,60px)] shrink-0 px-4",
          "border-b border-border",
          collapsed && "justify-center px-0",
        )}
      >
        {collapsed ? (
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-[11px] font-bold text-white">P</span>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0">
              <span className="text-[11px] font-bold text-white">P</span>
            </div>
            <span className="text-sm font-semibold text-foreground tracking-tight">
              Platform
            </span>
          </div>
        )}
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {nav.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href + "/"));
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                active
                  ? "bg-muted text-foreground font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
                collapsed && "justify-center px-0 w-9 mx-auto",
              )}
            >
              {item.icon && (
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  {item.icon}
                </span>
              )}
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </div>

      {/* User */}
      {!collapsed && (
        <div className="shrink-0 border-t border-border p-3">
          <div className="flex items-center gap-2.5 px-1 py-1">
            <div
              className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[11px] font-semibold text-white"
              style={{ background: "hsl(var(--primary))" }}
            >
              {(userEmail ?? "U")[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">
                {userEmail}
              </p>
              {role && (
                <p className="text-[11px] text-muted-foreground capitalize">
                  {role}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
