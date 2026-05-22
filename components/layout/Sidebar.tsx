"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";

export interface NavItem {
  label: string;
  href: string;
}

interface SidebarProps {
  nav: NavItem[];
  collapsed?: boolean;
}

export function Sidebar({ nav, collapsed }: SidebarProps) {
  const pathname = usePathname();

  return (
    <nav
      className={cn(
        "flex flex-col gap-1 py-4 px-2 h-full border-r border-border bg-background transition-all duration-200",
        collapsed ? "w-14" : "w-56",
      )}
    >
      <div className={cn("px-2 mb-4", collapsed && "hidden")}>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          [PLATFORM]
        </span>
      </div>
      {nav.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <span className={cn(!collapsed && "truncate")}>{collapsed ? item.label[0] : item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
