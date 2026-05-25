import Link from "next/link";
import { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export interface TabItem {
  label: string;
  href: string;
  active?: boolean;
}

interface PageHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
  tabs?: TabItem[];
  className?: string;
}

export function PageHeader({
  title,
  description,
  action,
  tabs,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("mb-6", className)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground tracking-tight">
            {title}
          </h1>
          {description && (
            <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      {tabs && tabs.length > 0 && (
        <nav
          className="flex items-center gap-0 mt-5 border-b border-border"
          aria-label="Page tabs"
        >
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
                tab.active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
              )}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
