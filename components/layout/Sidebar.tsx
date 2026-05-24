"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
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
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? nav.filter((n) => n.label.toLowerCase().includes(search.toLowerCase()))
    : nav;

  return (
    <nav
      className={cn(
        "flex flex-col h-full border-r border-border bg-background transition-[width] duration-200 overflow-hidden",
        collapsed ? "w-14" : "w-[var(--sidebar-w,232px)]",
      )}
      aria-label="Sidebar navigation"
    >
      {/* Logo / brand */}
      <div className={cn("flex items-center gap-2 px-4 h-[var(--topbar-h,56px)] shrink-0 border-b border-border", collapsed && "justify-center px-0")}>
        {collapsed ? (
          <span className="text-[13px] font-bold text-primary">P</span>
        ) : (
          <span className="text-[13px] font-semibold text-foreground tracking-tight">[PLATFORM]</span>
        )}
      </div>

      {/* Search slot */}
      {!collapsed && (
        <div className="px-3 pt-3 pb-1 shrink-0">
          <input
            type="search"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={cn(
              "w-full h-7 rounded-md border border-border bg-muted px-2.5 text-[12px]",
              "text-foreground placeholder:text-muted-foreground outline-none",
              "focus:ring-1 focus:ring-primary/30 focus:border-primary/50",
            )}
            aria-label="Search navigation"
          />
        </div>
      )}

      {/* Nav items */}
      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {filtered.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                "flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] transition-colors",
                active
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
                collapsed && "justify-center px-0 w-10 mx-auto",
              )}
            >
              {item.icon && (
                <span className="shrink-0 w-4 h-4 flex items-center justify-center opacity-70">
                  {item.icon}
                </span>
              )}
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </div>

      {/* Footer — role chip + email */}
      {!collapsed && (
        <div className="px-3 py-3 shrink-0 border-t border-border">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
              <span className="text-[10px] font-semibold text-primary uppercase">
                {(userEmail ?? "U")[0]}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-medium text-foreground truncate">{userEmail}</p>
              {role && (
                <p className="text-[10px] text-muted-foreground capitalize">{role}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
